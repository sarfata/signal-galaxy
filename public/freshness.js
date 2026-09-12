export function snapshotClock(serverTime, receivedAt) {
  const epoch = Date.parse(serverTime);
  return monotonicNow => epoch + Math.max(0, monotonicNow - receivedAt);
}
export function remainingTime(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return seconds >= 60 ? Math.floor(seconds / 60) + "m " + String(seconds % 60).padStart(2, "0") + "s" : seconds + "s";
}
export function freshness(subscriptions = [], now) {
  const labels = { push: "Push stream", poll: "Polling", webhook: "Webhook", reconnecting: "Reconnect grace" };
  const leases = subscriptions.map(s => {
    if (s.type === "push" && s.expiresAt === null) return { deadline: Infinity, fraction: 1, type: s.type, detail: "Push stream · connected, no TTL", short: "push · connected" };
    const deadline = Date.parse(s.expiresAt);
    const remaining = Math.max(0, deadline - now);
    const fraction = Number.isFinite(remaining) && s.ttlMs > 0 ? Math.min(1, remaining / s.ttlMs) : 0;
    const time = remaining > 0 ? remainingTime(remaining) + " left" : "expired";
    return { deadline: Number.isFinite(deadline) ? deadline : -Infinity, fraction, type: s.type, detail: (labels[s.type] ?? "Subscription") + " · " + time, short: s.type + " · " + time };
  });
  const longest = [...leases].sort((a, b) => b.deadline - a.deadline)[0];
  return { fraction: longest?.fraction ?? 0, summary: longest?.short ?? "Status unavailable", details: leases.map(s => s.detail).join("\n") || "Subscription status unavailable" };
}
