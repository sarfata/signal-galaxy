import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Galaxy } from "../src/galaxy.js";
import { WebhookService, decodeSecret, grantTtl, MAX_WEBHOOK_TTL_MS, type SubscribeRequest } from "../src/webhooks.js";
import { SafeWebhookHttpClient, UnsafeWebhookAddressError, isGloballyRoutableIp, parseWebhookUrl, type WebhookHttpClient } from "../src/webhook-http.js";
const secret = "whsec_" + Buffer.alloc(32, 7).toString("base64");
const otherSecret = "whsec_" + Buffer.alloc(32, 8).toString("base64");
const input: SubscribeRequest = { name: "galaxy.signal", arguments: { name: "Webhook test", clientId: "test-webhook-123" }, delivery: { mode: "webhook", url: "https://receiver.example/events", secret } };
let galaxy: Galaxy;
let hooks: WebhookService;
let posts: Array<{ url: string; body: string; headers: Record<string, string> }>;
let send: ReturnType<typeof vi.fn<WebhookHttpClient["post"]>>;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  posts = [];
  send = vi.fn(async (url, body, headers) => {
    posts.push({ url, body, headers });
    const payload = JSON.parse(body);
    return { status: 200, body: JSON.stringify(payload.type === "verification" ? { challenge: payload.challenge } : {}) };
  });
  galaxy = new Galaxy(); hooks = new WebhookService(galaxy, { post: send });
});
afterEach(async () => { await hooks.close(); galaxy.close(); vi.useRealTimers(); });
describe("anonymous temporary webhook ownership", () => {
  it("verifies before joining, publishes safe lease metadata, and caps TTL at 30 minutes", async () => {
    const result = await hooks.subscribe({ ...input, ttlMs: 99_000_000 }, "one-ip");
    expect(JSON.parse(posts[0].body).type).toBe("verification");
    expect(Date.parse(result.refreshBefore) - Date.now()).toBe(MAX_WEBHOOK_TTL_MS);
    const star = galaxy.list()[0];
    expect(star.id).toBe(result.subscriberId); expect(star.modes).toEqual(["webhook"]);
    expect(star.subscriptions[0].ttlMs).toBe(MAX_WEBHOOK_TTL_MS);
    expect(star.subscriptions[0].expiresAt).toBe(result.refreshBefore);
    for (const privateValue of [secret, "receiver.example", "one-ip", input.arguments.clientId]) expect(JSON.stringify(star)).not.toContain(privateValue);
  });
  it("renews using the same secret and ends ownership at the new expiry", async () => {
    const first = await hooks.subscribe({ ...input, ttlMs: 10_000 }, "a");
    await vi.advanceTimersByTimeAsync(9000);
    const second = await hooks.subscribe({ ...input, ttlMs: 10_000 }, "b");
    expect(second.id).toBe(first.id); expect(Date.parse(second.refreshBefore) - Date.parse(first.refreshBefore)).toBe(9000);
    expect(posts).toHaveLength(1); // A live owner does not repeatedly probe the endpoint.
    await vi.advanceTimersByTimeAsync(9000); expect(galaxy.list()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1001); expect(galaxy.list()).toEqual([]);
    const next = await hooks.subscribe({ ...input, delivery: { ...input.delivery, secret: otherSecret } }, "b");
    expect(next.subscriberId).toBe(first.subscriberId);
    expect(posts).toHaveLength(2); // Fresh registration and proof, no lasting ownership.
  });
  it("rejects guessed ownership on renewal and removal without changing the lease", async () => {
    const first = await hooks.subscribe(input, "a");
    const wrong = { ...input, delivery: { ...input.delivery, secret: otherSecret } };
    await expect(hooks.subscribe(wrong, "attacker")).rejects.toMatchObject({ code: -32012 });
    await expect(hooks.unsubscribe(wrong)).rejects.toMatchObject({ code: -32012 });
    expect(galaxy.list()[0].subscriptions[0].expiresAt).toBe(first.refreshBefore);
    expect(posts).toHaveLength(1);
    await hooks.unsubscribe(input); expect(galaxy.list()).toEqual([]);
    await expect(hooks.unsubscribe(input)).rejects.toMatchObject({ code: -32011 });
  });
  it("does not show a dot or leak the callback body when verification fails", async () => {
    send.mockResolvedValue({ status: 200, body: "private upstream response" });
    await expect(hooks.subscribe(input, "a")).rejects.toMatchObject({ code: -32015, data: { reason: "challenge_failed" } });
    expect(galaxy.list()).toEqual([]);
  });
  it("signs real ping/message events, preserves ordering, and maintains a safe replay cursor", async () => {
    const start = await hooks.subscribe(input, "a");
    const ping = galaxy.send(start.subscriberId, { kind: "ping" }, "v");
    const message = galaxy.send(start.subscriberId, { kind: "message", text: "Hello webhook" }, "v");
    await vi.advanceTimersByTimeAsync(1001);
    expect(posts.slice(1).map(p => JSON.parse(p.body).data.kind)).toEqual(["ping", "message"]);
    for (const post of posts) {
      const h = post.headers;
      expect(h["webhook-signature"]).toBe("v1," + createHmac("sha256", decodeSecret(secret)).update(`${h["webhook-id"]}.${h["webhook-timestamp"]}.${post.body}`).digest("base64"));
      expect(h["X-MCP-Subscription-Id"]).toBe(start.id);
    }
    expect(posts[1].headers["webhook-id"]).toBe(ping.eventId);
    expect((await hooks.subscribe(input, "a")).cursor).toBe(message.cursor);
  });
  it("retries with the same event ID and does not advance past an unacknowledged delivery", async () => {
    const start = await hooks.subscribe(input, "a");
    send.mockImplementation(async (url, body, headers) => { posts.push({ url, body, headers }); return { status: posts.length < 3 ? 503 : 200, body: "{}" }; });
    galaxy.send(start.subscriberId, { kind: "ping" }, "v");
    await vi.advanceTimersByTimeAsync(0);
    expect((await hooks.subscribe(input, "a")).cursor).toBe(start.cursor);
    await vi.advanceTimersByTimeAsync(1001);
    expect(posts[1].headers["webhook-id"]).toBe(posts[2].headers["webhook-id"]);
    expect(posts[1].headers["webhook-signature"]).not.toBe(posts[2].headers["webhook-signature"]);
  });
  it("stops retries on explicit removal and retains other modes on the same dot", async () => {
    const start = await hooks.subscribe(input, "a");
    galaxy.poll(input, "a");
    send.mockResolvedValue({ status: 503, body: "ignored" });
    galaxy.send(start.subscriberId, { kind: "ping" }, "v");
    await vi.advanceTimersByTimeAsync(0);
    await hooks.unsubscribe(input);
    const count = send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send.mock.calls).toHaveLength(count);
    expect(galaxy.list()[0].modes).toEqual(["poll"]);
  });
  it("enforces per-dot callback limits and aborts expired delivery", async () => {
    await hooks.subscribe({ ...input, ttlMs: 5000 }, "a");
    await hooks.subscribe({ ...input, delivery: { ...input.delivery, url: "https://second.example/events" }, ttlMs: 5000 }, "a");
    await expect(hooks.subscribe({ ...input, delivery: { ...input.delivery, url: "https://third.example/events" } }, "a")).rejects.toMatchObject({ code: -32013 });
    expect(galaxy.list()[0].subscriptions).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5001); expect(galaxy.list()).toEqual([]);
  });
  it("does not create a lease after an aborted verification", async () => {
    const abort = new AbortController(); abort.abort();
    await expect(hooks.subscribe(input, "a", abort.signal)).rejects.toBeDefined();
    expect(galaxy.list()).toEqual([]);
  });
});
describe("webhook input and SSRF boundaries", () => {
  it("accepts only canonical high-entropy-shaped Standard Webhooks secrets and finite grants", () => {
    expect(decodeSecret(secret)).toHaveLength(32);
    for (const value of ["password", "whsec_YQ==", "whsec_" + Buffer.alloc(65).toString("base64"), secret.replace(/=+$/, "")]) expect(() => decodeSecret(value)).toThrow();
    expect(grantTtl(null)).toBe(MAX_WEBHOOK_TTL_MS); expect(grantTtl(0)).toBe(5000);
    expect(() => grantTtl(-1)).toThrow(); expect(() => grantTtl(Infinity)).toThrow();
  });
  it("blocks private, loopback, metadata, reserved and mapped addresses", async () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "192.0.2.1", "224.0.0.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "2001:db8::1", "2002:7f00:1::1"]) expect(isGloballyRoutableIp(ip)).toBe(false);
    expect(isGloballyRoutableIp("1.1.1.1")).toBe(true);
    expect(isGloballyRoutableIp("2606:4700:4700::1111")).toBe(true);
    await expect(new SafeWebhookHttpClient().post("https://127.0.0.1/", "{}", {}, new AbortController().signal)).rejects.toBeInstanceOf(UnsafeWebhookAddressError);
  });
  it("rejects non-HTTPS, credentials and fragments", () => {
    for (const url of ["http://example.com", "https://user:pass@example.com", "https://example.com/#secret", "not-a-url"]) expect(() => parseWebhookUrl(url)).toThrow();
  });
});
