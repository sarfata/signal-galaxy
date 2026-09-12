/** Defer the ping so a double-click becomes one compose action, not a ping. */
export function clickIntent({ ping, compose, delay = 500 }) {
  const pending = new Map();
  return {
    click(id, detail = 1) {
      if (detail === 0) { this.cancel(id); ping(id); return; } // Keyboard activation.
      if (detail > 1 || pending.has(id)) { this.cancel(id); compose(id); return; }
      pending.set(id, setTimeout(() => { pending.delete(id); ping(id); }, delay));
    },
    cancel(id) { clearTimeout(pending.get(id)); pending.delete(id); },
    clear() { for (const id of pending.keys()) this.cancel(id); }
  };
}
