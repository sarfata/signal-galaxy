import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod/v4";

// Run with: node scripts/webhook-smoke.mjs ORIGIN /path/to/cloudflared
// Publishes only this disposable, signature-checking test receiver via a Quick
// Tunnel. Secrets stay in memory. Never forwards to another local service.
const base = new URL(process.argv[2] ?? "http://localhost:3000").origin;
const binary = process.argv[3];
assert(binary, "Pass the path to a verified cloudflared binary");
const bytes = randomBytes(32);
const secret = "whsec_" + bytes.toString("base64");
const callbackPath = "/events/" + randomUUID();
const arrivals = [];
const receiver = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== callbackPath) { response.writeHead(404).end(); return; }
  try {
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > 16_384) { response.writeHead(413).end(); return; } chunks.push(chunk); }
    const body = Buffer.concat(chunks).toString("utf8");
    const id = request.headers["webhook-id"];
    const timestamp = request.headers["webhook-timestamp"];
    const expected = "v1," + createHmac("sha256", bytes).update(`${id}.${timestamp}.${body}`).digest("base64");
    const supplied = Buffer.from(String(request.headers["webhook-signature"] ?? ""));
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, Buffer.from(expected)) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) { response.writeHead(401).end(); return; }
    const payload = JSON.parse(body);
    arrivals.push({ id, subscriptionId: request.headers["x-mcp-subscription-id"], payload });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(payload.type === "verification" ? { challenge: payload.challenge } : {}));
  } catch { response.writeHead(400).end(); }
});
const client = new Client({ name: "galaxy-webhook-smoke", version: "1" }, { versionNegotiation: { mode: "auto" } });
const schema = z.record(z.string(), z.unknown());
let tunnel;
let tunnelLog = "";
let removal;
let registered = false;
async function until(check, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(200); }
  throw new Error("Timed out waiting for the HTTPS webhook test");
}
async function roster() { return (await (await fetch(base + "/api/subscribers", { signal: AbortSignal.timeout(5000) })).json()).subscribers; }
try {
  await new Promise(resolve => receiver.listen(0, "127.0.0.1", resolve));
  const address = receiver.address();
  tunnel = spawn(binary, ["tunnel", "--url", `http://127.0.0.1:${address.port}`, "--protocol", "http2", "--no-autoupdate"], { stdio: ["ignore", "ignore", "pipe"] });
  const publicUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Quick Tunnel did not become available")), 30_000);
    tunnel.stderr.on("data", chunk => { tunnelLog = (tunnelLog + chunk).slice(-20_000); const match = tunnelLog.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    tunnel.once("error", error => { clearTimeout(timer); reject(error); });
    tunnel.once("exit", () => { clearTimeout(timer); reject(new Error("Quick Tunnel exited")); });
  });
  console.log(JSON.stringify({ phase: "receiver-started", hostname: new URL(publicUrl).hostname }));
  // Only the MCP server needs to resolve/reach the receiver. A client may sit
  // behind a DNS policy that cannot resolve the callback domain; the server's
  // signed challenge below is the authoritative end-to-end readiness check.
  await until(() => /Registered tunnel connection/.test(tunnelLog), 30_000);
  await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
  const params = { name: "galaxy.signal", arguments: { name: "Webhook test " + randomUUID().slice(0, 6), clientId: randomUUID() }, delivery: { mode: "webhook", url: publicUrl + callbackPath, secret }, ttlMs: 15_000 };
  removal = { name: params.name, arguments: params.arguments, delivery: { url: params.delivery.url, secret } };
  let start;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { start = await client.request({ method: "events/subscribe", params }, schema); break; }
    catch (error) {
      if (attempt === 2 || error.code !== -32015 || !["connection_refused", "timeout", "http_5xx"].includes(error.data?.reason)) throw error;
      // Quick Tunnel edge/DNS propagation can lag its registered connection.
      // Retry the complete signed verification; never bypass the challenge.
      await delay(2000 * (attempt + 1));
    }
  }
  registered = true;
  assert(arrivals.some(a => a.payload.type === "verification"));
  const star = (await roster()).find(s => s.id === start.subscriberId);
  assert.deepEqual(star.modes, ["webhook"]);
  assert.equal(star.subscriptions[0].expiresAt, start.refreshBefore);
  for (const body of [{ kind: "ping" }, { kind: "message", text: "A signed signal across HTTPS 🌌" }]) {
    const response = await fetch(base + "/api/subscribers/" + start.subscriberId + "/signals", { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 202);
  }
  await until(() => arrivals.filter(a => a.payload.name === "galaxy.signal").length === 2);
  const events = arrivals.filter(a => a.payload.name === "galaxy.signal");
  assert.deepEqual(events.map(a => a.payload.data.kind), ["ping", "message"]);
  assert(events.every(a => a.subscriptionId === start.id && a.id === a.payload.eventId));
  const wrongSecret = "whsec_" + randomBytes(32).toString("base64");
  await assert.rejects(client.request({ method: "events/subscribe", params: { ...params, delivery: { ...params.delivery, secret: wrongSecret } } }, schema), error => error.code === -32012);
  await assert.rejects(client.request({ method: "events/unsubscribe", params: { ...removal, delivery: { ...removal.delivery, secret: wrongSecret } } }, schema), error => error.code === -32012);
  await delay(1000);
  const renewed = await client.request({ method: "events/subscribe", params }, schema);
  assert.equal(renewed.id, start.id);
  assert(Date.parse(renewed.refreshBefore) > Date.parse(start.refreshBefore));
  assert.equal(arrivals.filter(a => a.payload.type === "verification").length, 1);
  assert.equal((await roster()).find(s => s.id === start.subscriberId).subscriptions[0].expiresAt, renewed.refreshBefore);
  await client.request({ method: "events/unsubscribe", params: removal }, schema);
  registered = false;
  assert(!(await roster()).some(s => s.id === start.subscriberId));
  const expiring = await client.request({ method: "events/subscribe", params: { ...params, ttlMs: 5000 } }, schema);
  registered = true;
  assert.equal(arrivals.filter(a => a.payload.type === "verification").length, 2);
  await until(async () => !(await roster()).some(s => s.id === expiring.subscriberId), 10_000);
  registered = false;
  console.log(JSON.stringify({ ok: true, base, verified: ["HTTPS callback verification", "Standard Webhooks signatures", "ping and text delivery", "private metadata omitted", "wrong-secret rejection", "lease renewal", "explicit removal", "TTL expiry", "fresh proof after removal"] }));
} finally {
  if (registered) await client.request({ method: "events/unsubscribe", params: removal }, schema).catch(() => {});
  await client.close();
  tunnel?.kill("SIGTERM");
  receiver.closeAllConnections();
  await new Promise(resolve => receiver.close(resolve));
}
