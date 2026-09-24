import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
const fixtures: ReturnType<typeof createApp>[] = [];
function setup(options: Parameters<typeof createApp>[1] = {}) { const f = createApp("http://localhost:3011", { trustFlyProxy: true, ...options }); fixtures.push(f); return f; }
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
async function rpc(f: ReturnType<typeof createApp>, method: string, params: object = {}, ip = "192.0.2.1") {
  const response = await f.app.request("/mcp", { method: "POST", headers: { Host: "localhost:3011", "Content-Type": "application/json", Accept: "application/json, text/event-stream", "fly-client-ip": ip }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const text = await response.text();
  const messages = response.headers.get("content-type")?.includes("text/event-stream") ? text.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => JSON.parse(l.slice(5))) : [JSON.parse(text)];
  return { response, message: messages.find(m => m.id === 1) };
}
const params = { name: "galaxy.signal", arguments: { name: "Test star", clientId: "test-client-uuid" } };
describe("MCP + public visitor API", () => {
  it("serves only the exact configured verification token as public, non-cacheable plain text", async () => {
    const token = "test-domain-verification-token_0123456789-AbCd";
    const f = setup({ openaiAppsChallenge: `  ${token}\n` });
    const response = await f.app.request("/.well-known/openai-apps-challenge");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/plain; charset=utf-8$/i);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.has("location")).toBe(false);
    expect(await response.text()).toBe(token);
    const head = await f.app.request("/.well-known/openai-apps-challenge", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });
  it("does not publish a placeholder when no verification token is configured", async () => {
    for (const openaiAppsChallenge of [undefined, "", " \n"]) {
      const response = await setup({ openaiAppsChallenge }).app.request("/.well-known/openai-apps-challenge");
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(() => setup({ openaiAppsChallenge: "first-token\nsecond-token" })).toThrow("single verification token");
    expect(() => setup({ openaiAppsChallenge: "x".repeat(4097) })).toThrow("single verification token");
  });
  it("advertises all three safety hints on every MCP tool without creating a subscription", async () => {
    const f = setup();
    const listed = await rpc(f, "tools/list");
    expect(listed.response.status).toBe(200);
    expect(listed.message.error).toBeUndefined();
    const annotations = Object.fromEntries(listed.message.result.tools.map((tool: { name: string; annotations?: unknown }) => [tool.name, tool.annotations]));
    expect(annotations).toEqual({
      subscribers_list: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
    });
    expect(f.galaxy.list()).toEqual([]);
  });
  it("serves the galaxy and deployment-specific guide with safe headers", async () => {
    const f = setup();
    for (const path of ["/", "/app.js", "/clicks.js", "/style.css", "/favicon.svg", "/health"]) expect((await f.app.request(path)).status).toBe(200);
    const page = await f.app.request("/");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    const guide = await (await f.app.request("/agents.md")).text();
    expect(guide).toContain("http://localhost:3011/mcp"); expect(guide).not.toContain("https://signal-galaxy.fly.dev");
  });
  it("initializes anonymously and advertises all modes plus the ownership deviation", async () => {
    const f = setup();
    const init = await rpc(f, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.response.status).toBe(200); expect(init.message.result.capabilities.events).toBeTruthy();
    const listed = await rpc(f, "events/list");
    expect(listed.message.result.events[0].delivery).toEqual(["push", "poll", "webhook"]);
    expect(listed.message.result.events[0]._meta["signal-galaxy/webhook-ownership"].draftDeviation).toBe(true);
    expect(listed.message.result.events[0].inputSchema.required).toEqual(["name", "clientId"]);
    expect((await rpc(f, "tools/call", { name: "subscribers_list", arguments: {} })).message.result.structuredContent.subscribers).toEqual([]);
  });
  it("connects a named poll client, routes a real HTTP message into its MCP events, and isolates peers", async () => {
    const f = setup(); const started = await rpc(f, "events/poll", params);
    const list = await (await f.app.request("/api/subscribers")).json(); const id = list.subscribers[0].id;
    const response = await f.app.request("/api/subscribers/" + id + "/signals", { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:3011", "fly-client-ip": "192.0.2.2" }, body: JSON.stringify({ kind: "message", text: "<script>alert(1)</script>" }) });
    expect(response.status).toBe(202);
    const polled = await rpc(f, "events/poll", { ...params, cursor: started.message.result.cursor });
    expect(polled.message.result.events[0].data.text).toBe("<script>alert(1)</script>");
    expect(polled.message.result.events[0].data.anonymous).toBe(true);
    for (let i = 0; i < 8; i++) expect((await rpc(f, "events/poll", { ...params, arguments: { name: "Other", clientId: "another-client-" + i } }, "other-ip")).message.error).toBeUndefined();
    expect((await rpc(f, "events/poll", { ...params, arguments: { name: "Other", clientId: "another-client-9" } }, "other-ip")).message.error.code).toBe(-32013);
  });
  it("rejects missing names, unsafe origins, oversized bodies, invalid text, and nonexistent targets", async () => {
    const f = setup();
    expect((await rpc(f, "events/poll", { name: "galaxy.signal", arguments: { clientId: "12345678" } })).message.error.code).toBe(-32602);
    const post = (body: object, extra = {}) => f.app.request("/api/subscribers/unknown/signals", { method: "POST", headers: { "Content-Type": "application/json", ...extra }, body: JSON.stringify(body) });
    expect((await post({ kind: "ping" }, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ kind: "message", text: "x".repeat(201) })).status).toBe(400);
    expect((await post({ kind: "message", text: "x".repeat(3000) })).status).toBe(413);
    expect((await post({ kind: "ping" })).status).toBe(404);
    expect((await f.app.request("/api/subscribers/x/signals", { method: "POST", body: "hello" })).status).toBe(415);
    const badHost = await f.app.request("/mcp", { method: "POST", headers: { Host: "evil.example", "Content-Type": "application/json" }, body: "{}" });
    expect(badHost.status).toBe(403);
  });
  it("provides retry information when anonymous pings exceed the target budget", async () => {
    const f = setup(); await rpc(f, "events/poll", params); const id = f.galaxy.list()[0].id;
    let response!: Response;
    for (let i = 0; i < 13; i++) response = await f.app.request("/api/subscribers/" + id + "/signals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "ping" }) });
    expect(response.status).toBe(429); expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await response.json()).retryAfterMs).toBeGreaterThan(0);
  });
  it("routes webhook registration and protected removal through the official MCP handler", async () => {
    const secret = "whsec_" + Buffer.alloc(32, 9).toString("base64");
    const f = setup({ webhookHttp: { post: async (_url, body) => ({ status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) }) } });
    const delivery = { url: "https://receiver.example/callback", secret };
    const started = await rpc(f, "events/subscribe", { ...params, delivery: { ...delivery, mode: "webhook" }, ttlMs: 30_000 });
    expect(started.message.error).toBeUndefined();
    const snapshot = await (await f.app.request("/api/subscribers")).json();
    expect(Date.parse(snapshot.serverTime)).toBeGreaterThan(0);
    expect(snapshot.subscribers[0].subscriptions[0].expiresAt).toBe(started.message.result.refreshBefore);
    expect((await rpc(f, "events/unsubscribe", { ...params, delivery: { url: delivery.url } })).message.error.code).toBe(-32602);
    expect((await rpc(f, "events/unsubscribe", { ...params, delivery })).message.error).toBeUndefined();
    expect(f.galaxy.list()).toEqual([]);
  });
});
