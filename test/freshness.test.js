import { describe, expect, it } from "vitest";
import { freshness, remainingTime, snapshotClock } from "../public/freshness.js";
const lease = (type = "poll", start = 1000, ttlMs = 90_000) => ({ type, renewedAt: new Date(start).toISOString(), expiresAt: new Date(start + ttlMs).toISOString(), ttlMs });
describe("subscription freshness visualization", () => {
  it("shrinks to zero at expiry and refills on actual renewal", () => {
    expect(freshness([lease()], 1000).fraction).toBe(1);
    expect(freshness([lease()], 46_000).fraction).toBe(.5);
    expect(freshness([lease()], 91_000).fraction).toBe(0);
    expect(freshness([lease("poll", 46_000)], 46_000).fraction).toBe(1);
    expect(freshness([lease()], 100_000).summary).toContain("expired");
  });
  it("keeps a connected push ring full without inventing a TTL", () => {
    const push = { type: "push", renewedAt: new Date(1000).toISOString(), expiresAt: null, ttlMs: null };
    const result = freshness([lease(), push], 1_800_000);
    expect(result.fraction).toBe(1); expect(result.details).toContain("connected, no TTL");
  });
  it("uses the longest-lived lease and describes every delivery mode", () => {
    const result = freshness([lease(), lease("webhook", 1000, 1_800_000)], 901_000);
    expect(result.fraction).toBe(.5); expect(result.details).toContain("Polling · expired");
    expect(result.details).toContain("Webhook · 15m 00s left");
  });
  it("shows reconnect grace and clamps malformed/expired timestamps", () => {
    expect(freshness([lease("reconnecting", 1000, 10_000)], 6000).details).toBe("Reconnect grace · 5s left");
    expect(freshness([{ ...lease(), expiresAt: "invalid" }], 6000).fraction).toBe(0);
    expect(freshness([], 6000).summary).toBe("Status unavailable");
  });
  it("uses monotonic elapsed time from a server snapshot, not browser wall time", () => {
    const now = snapshotClock("2026-09-12T00:00:00.000Z", 20);
    expect(now(1020)).toBe(Date.parse("2026-09-12T00:00:01.000Z"));
    expect(now(0)).toBe(Date.parse("2026-09-12T00:00:00.000Z"));
    expect(remainingTime(1_799_001)).toBe("30m 00s");
    expect(remainingTime(-1)).toBe("0s");
  });
});
