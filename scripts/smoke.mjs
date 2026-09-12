import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod/v4";

// Registers temporary, clearly named test listeners and sends only to those IDs.
const base = new URL(process.argv[2] ?? "http://localhost:3000").origin;
const mode = process.argv[3] ?? "auto";
assert(["auto", "legacy"].includes(mode), "Use auto or legacy as the optional protocol mode");
const client = new Client({ name: "signal-galaxy-smoke", version: "0.1.0" }, { versionNegotiation: { mode } });
const pollClient = new Client({ name: "signal-galaxy-poll-smoke", version: "0.1.0" }, { versionNegotiation: { mode } });
const schema = z.record(z.string(), z.unknown());
const received = [];
let streamError;
const stop = new AbortController();
let stream;
const args = { name: "SDK test " + randomUUID().slice(0, 8), clientId: randomUUID() };
const params = { name: "galaxy.signal", arguments: args };
async function until(check, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (streamError) throw streamError;
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  throw new Error("Timed out waiting for the expected MCP lifecycle state");
}
async function roster() {
  const response = await fetch(base + "/api/subscribers", { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200);
  return (await response.json()).subscribers;
}
async function send(id, body) {
  const response = await fetch(base + "/api/subscribers/" + id + "/signals", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10_000)
  });
  assert.equal(response.status, 202, await response.text());
}
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
  assert.equal(client.getProtocolEra(), mode === "auto" ? "modern" : "legacy");
  assert((await client.listTools()).tools.some(tool => tool.name === "subscribers_list"));
  const catalog = await client.request({ method: "events/list", params: {} }, schema);
  assert.deepEqual(catalog.events[0].delivery, ["push", "poll", "webhook"]);
  for (const method of ["active", "event", "heartbeat"]) {
    client.setNotificationHandler("notifications/events/" + method, { params: schema }, data => {
      received.push({ method, data });
    });
  }
  stream = client.request({ method: "events/stream", params }, schema, { signal: stop.signal, timeout: 90_000 })
    .catch(error => { if (!stop.signal.aborted) streamError = error; });
  const active = await until(() => received.find(n => n.method === "active")?.data);
  assert((await roster()).some(s => s.id === active.subscriberId && s.name === args.name && s.modes.includes("push")));
  await send(active.subscriberId, { kind: "ping" });
  await send(active.subscriberId, { kind: "message", text: "Hello from the SDK smoke test 🌌" });
  await until(() => received.filter(n => n.method === "event").length === 2);
  assert.deepEqual(received.filter(n => n.method === "event").map(n => n.data.data.kind), ["ping", "message"]);
  assert.equal(received.find(n => n.data.data?.kind === "message").data.data.text, "Hello from the SDK smoke test 🌌");
  await until(() => received.some(n => n.method === "heartbeat"), 30_000);
  stop.abort();
  await stream;
  // Legacy stateless HTTP cannot route a separate notifications/cancelled POST
  // to a previous request. Close its transport; modern requests abort their SSE.
  if (mode === "legacy") await client.close();
  await until(async () => !(await roster()).some(s => s.id === active.subscriberId), 20_000);

  await pollClient.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
  const pollParams = { name: "galaxy.signal", arguments: { name: "Poll test " + randomUUID().slice(0, 8), clientId: randomUUID() } };
  const first = await pollClient.request({ method: "events/poll", params: pollParams }, schema);
  assert.deepEqual(first.events, []);
  const pollStar = (await roster()).find(s => s.name === pollParams.arguments.name && s.modes.includes("poll"));
  assert(pollStar);
  await send(pollStar.id, { kind: "message", text: "Polling works too" });
  const second = await pollClient.request({ method: "events/poll", params: { ...pollParams, cursor: first.cursor } }, schema);
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].data.text, "Polling works too");
  const replay = await pollClient.request({ method: "events/poll", params: { ...pollParams, cursor: first.cursor } }, schema);
  assert.deepEqual(replay.events, second.events);
  console.log(JSON.stringify({ ok: true, base, mode, verified: ["official SDK connection", "event discovery", "named presence", "push ping", "push text", "heartbeat", "disconnect expiry", "poll delivery", "cursor replay"], pollTestExpiresInSeconds: 90 }));
} finally {
  stop.abort();
  if (stream) await stream;
  await client.close();
  await pollClient.close();
}
