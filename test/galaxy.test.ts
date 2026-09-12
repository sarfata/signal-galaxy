import { afterEach, describe, expect, it, vi } from "vitest";
import { Galaxy, EVENT_NAME, ArgumentsSchema, LimitError, Limiter } from "../src/galaxy.js";
import type { ServerContext } from "@modelcontextprotocol/server";
const request = (name = "Voyager", clientId = "client-012345") => ({ name: EVENT_NAME, arguments: { name, clientId } });
const alive: Galaxy[] = [];
const make = (now?: () => number) => { const galaxy = new Galaxy(now); alive.push(galaxy); return galaxy; };
afterEach(() => { alive.splice(0).forEach(g => g.close()); vi.useRealTimers(); });

describe("anonymous galaxy lifecycle", () => {
  it("requires a name and a stable client ID; rejects control characters and extra arguments", () => {
    for (const args of [{}, { name: "x" }, { name: "", clientId: "abcdefgh" }, { name: "x".repeat(33), clientId: "abcdefgh" },
      { name: "x\n", clientId: "short" }, { name: "a\u202eb", clientId: "abcdefgh" }, { name: "x", clientId: "space id" }, { name: "x", clientId: "abcdefgh", extra: true }]) {
      expect(ArgumentsSchema.safeParse(args).success).toBe(false);
    }
    expect(ArgumentsSchema.parse({ name: "  🛰 Voyager  ", clientId: "abcdefgh" }).name).toBe("🛰 Voyager");
  });
  it("first poll creates one dot; repeat poll keeps it; IP and clientId stay out of public data", () => {
    const g = make(); expect(g.list()).toEqual([]);
    const start = g.poll(request(), "192.0.2.1");
    expect(start.events).toEqual([]); expect(start.truncated).toBe(false);
    g.poll(request(), "192.0.2.1");
    expect(g.list()).toHaveLength(1);
    expect(JSON.stringify(g.list())).not.toContain("192.0.2.1");
    expect(JSON.stringify(g.list())).not.toContain("client-012345");
  });
  it("supports duplicate names without mixing their deliveries", () => {
    const g = make(); const a = request(); const b = request("Voyager", "other-client");
    const startA = g.poll(a, "a"); const startB = g.poll(b, "b");
    const [starA, starB] = g.list();
    g.send(starA.id, { kind: "ping" }, "visitor");
    expect(g.poll({ ...a, cursor: startA.cursor }, "a").events).toHaveLength(1);
    expect(g.poll({ ...b, cursor: startB.cursor }, "b").events).toHaveLength(0);
    expect(starA.id).not.toBe(starB.id);
  });
  it("expires poll-only subscribers after 90 seconds and renews on polling", () => {
    let now = 1000; const g = make(() => now);
    g.poll(request(), "a"); now += 89_000; expect(g.list()).toHaveLength(1);
    g.poll(request(), "a"); now += 89_000; expect(g.list()).toHaveLength(1);
    now += 1001; expect(g.list()).toEqual([]);
  });
  it("flags history loss after restart or expiration", () => {
    let now = 1000; const g = make(() => now);
    const start = g.poll(request(), "a");
    const restarted = make().poll({ ...request(), cursor: start.cursor }, "a");
    expect(restarted.truncated).toBe(true);
    now += 91_000;
    expect(g.poll({ ...request(), cursor: start.cursor }, "a").truncated).toBe(true);
  });
  it("delivers pings and Unicode messages with stable IDs and non-destructive replay", () => {
    const g = make(); const start = g.poll(request(), "a"); const star = g.list()[0];
    const ping = g.send(star.id, { kind: "ping" }, "v");
    const message = g.send(star.id, { kind: "message", text: "🌌".repeat(200) }, "v");
    const result = g.poll({ ...request(), cursor: start.cursor }, "a");
    expect(result.events).toEqual([ping, message]);
    expect(g.poll({ ...request(), cursor: start.cursor }, "a").events).toEqual(result.events);
    expect(ping.data).not.toHaveProperty("text");
    expect(message.data.anonymous).toBe(true);
    expect(g.poll({ ...request(), cursor: result.cursor }, "a").events).toEqual([]);
  });
  it("rejects invalid messages and missing subscribers without adding events", () => {
    const g = make(); g.poll(request(), "a"); const star = g.list()[0];
    for (const body of [{ kind: "message", text: "" }, { kind: "message", text: " " }, { kind: "message", text: "🌌".repeat(201) }, { kind: "ping", text: "unexpected" }]) expect(() => g.send(star.id, body as any, "v")).toThrow();
    expect(() => g.send("unknown", { kind: "ping" }, "v")).toThrow();
    expect(g.list()[0].signalCount).toBe(0);
  });
  it("enforces target limits across unrelated sender IPs, without publishing rejected events", () => {
    const g = make(() => 1000); g.poll(request(), "a"); const id = g.list()[0].id;
    for (let i = 0; i < 12; i++) g.send(id, { kind: "ping" }, "visitor-" + i);
    expect(() => g.send(id, { kind: "ping" }, "another")).toThrow(LimitError);
    expect(g.list()[0].signalCount).toBe(12);
  });
  it("limits subscribers per source IP", () => {
    const g = make();
    for (let i = 0; i < 8; i++) g.poll(request("Voyager", "client-id-" + i), "a");
    expect(() => g.poll(request("Voyager", "client-id-9"), "a")).toThrow();
    expect(g.list()).toHaveLength(8);
  });
  it("bounds replay to 50 events, flags truncation, and respects batch size and max age", () => {
    let now = 0; const g = make(() => now); const start = g.poll(request(), "a"); const id = g.list()[0].id;
    for (let i = 0; i < 55; i++) { now += 5001; g.poll(request(), "a"); g.send(id, { kind: "ping" }, "v"); }
    const batch = g.poll({ ...request(), cursor: start.cursor, maxEvents: 10 }, "a");
    expect(batch.events).toHaveLength(10); expect(batch.truncated).toBe(true); expect(batch.hasMore).toBe(true);
    const rest = g.poll({ ...request(), cursor: batch.cursor }, "a");
    expect(rest.events).toHaveLength(40); expect(rest.hasMore).toBe(false);
    const recent = g.poll({ ...request(), cursor: start.cursor, maxAgeMs: 1000 }, "a");
    expect(recent.events).toHaveLength(1); expect(recent.truncated).toBe(true);
  });
  it("rejects unknown events and malformed cursors", () => {
    const g = make();
    expect(() => g.poll({ ...request(), name: "other" }, "a")).toThrow();
    expect(() => g.poll({ ...request(), cursor: "made-up" }, "a")).toThrow();
  });
  it("stream announces presence, sends live events, and releases after disconnect grace", async () => {
    let now = 1000; const g = make(() => now); const stop = new AbortController(); const received: any[] = [];
    const ctx = { mcpReq: { id: "my-stream", signal: stop.signal, notify: async (m: any) => { received.push(m); } } } as ServerContext;
    const running = g.stream(request(), "a", ctx);
    await new Promise(resolve => setImmediate(resolve));
    expect(g.list()[0].modes).toEqual(["push"]);
    expect(received[0].method).toBe("notifications/events/active");
    expect(received[0].params._meta["io.modelcontextprotocol/subscriptionId"]).toBe("my-stream");
    g.send(g.list()[0].id, { kind: "message", text: "Hello!" }, "v");
    await new Promise(resolve => setImmediate(resolve));
    expect(received[1].params.data.text).toBe("Hello!");
    stop.abort(); await running;
    now += 9999; expect(g.list()).toHaveLength(1);
    now += 2; expect(g.list()).toEqual([]);
  });
  it("never advances the active cursor past replay events not yet delivered", async () => {
    const g = make(); const first = g.poll(request(), "a"); const id = g.list()[0].id;
    const event = g.send(id, { kind: "ping" }, "v");
    const stop = new AbortController(); const received: any[] = [];
    const ctx = { mcpReq: { id: 1, signal: stop.signal, notify: async (m: any) => { received.push(m); } } } as ServerContext;
    const running = g.stream({ ...request(), cursor: first.cursor }, "a", ctx);
    await new Promise(resolve => setImmediate(resolve));
    expect(received[0].params.cursor).toBe(first.cursor);
    expect(received[1].params.cursor).toBe(event.cursor);
    stop.abort(); await running;
  });
  it("does not accumulate an unbounded queue for a slow consumer", async () => {
    let now = 1000; const g = make(() => now); const stop = new AbortController();
    const ctx = { mcpReq: { id: 1, signal: stop.signal, notify: () => new Promise<void>(() => {}) } } as ServerContext;
    const running = g.stream(request(), "a", ctx);
    const id = g.list()[0].id;
    for (let i = 0; i < 66; i++) { now += 5001; g.send(id, { kind: "ping" }, "v"); }
    await running; expect(g.list()[0].modes).toEqual([]);
  });
});

describe("bounded rate buckets", () => {
  it("refills continuously and rejects atomically across all budgets", () => {
    let now = 0; const limiter = new Limiter(() => now);
    const shared = { key: "shared", capacity: 1, period: 1000 };
    limiter.consume([shared]);
    expect(() => limiter.consume([{ key: "fresh", capacity: 1, period: 1000 }, shared])).toThrow(LimitError);
    limiter.consume([{ key: "fresh", capacity: 1, period: 1000 }]);
    now = 999; expect(() => limiter.consume([shared])).toThrow();
    now = 1000; expect(() => limiter.consume([shared])).not.toThrow();
  });
});
