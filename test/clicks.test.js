import { afterEach, describe, expect, it, vi } from "vitest";
import { clickIntent } from "../public/clicks.js";
afterEach(() => vi.useRealTimers());
describe("ping / double-click message intent", () => {
  function setup() { vi.useFakeTimers(); const ping = vi.fn(), compose = vi.fn(); return { ping, compose, intent: clickIntent({ ping, compose }) }; }
  it("sends exactly one ping after the double-click window", () => { const { intent, ping, compose } = setup(); intent.click("a"); vi.advanceTimersByTime(499); expect(ping).not.toHaveBeenCalled(); vi.advanceTimersByTime(1); expect(ping.mock.calls).toEqual([["a"]]); expect(compose).not.toHaveBeenCalled(); });
  it("double-click opens one composer and sends no ping", () => { const { intent, ping, compose } = setup(); intent.click("a"); vi.advanceTimersByTime(180); intent.click("a", 2); vi.advanceTimersByTime(1000); expect(ping).not.toHaveBeenCalled(); expect(compose.mock.calls).toEqual([["a"]]); });
  it("supports keyboard activation and canceling pending pings", () => { const { intent, ping } = setup(); intent.click("a"); intent.cancel("a"); intent.click("b", 0); vi.advanceTimersByTime(1000); expect(ping.mock.calls).toEqual([["b"]]); });
  it("keeps different subscribers independent and cancels on navigation", () => { const { intent, ping } = setup(); intent.click("a"); intent.click("b"); vi.advanceTimersByTime(500); expect(ping.mock.calls).toEqual([["a"], ["b"]]); intent.click("c"); intent.clear(); vi.advanceTimersByTime(1000); expect(ping).toHaveBeenCalledTimes(2); });
});
