import { clickIntent } from "./clicks.js";
import { freshness, snapshotClock } from "./freshness.js";
const $ = id => document.getElementById(id);
const colors = ["#d9fa86", "#99caff", "#d5a0fc", "#ffbba3", "#9ef2d6", "#f3d58d"];
let subscribers = [];
let selected = null;
let online = false;
let toastTimer;
let polling = true;
const nodes = new Map();
let serverNow = () => Date.now();
let freshnessTimer;
const label = s => s.name + " · " + s.id.slice(-4);
const intent = clickIntent({ ping: id => sendSignal(id, "ping").catch(() => {}), compose: id => compose(id) });

function toast(text) {
  $("toast").textContent = text; $("toast").classList.add("visible");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $("toast").classList.remove("visible"), 3500);
}
function connect() { intent.clear(); $("instructions").showModal(); }
$("connect").onclick = connect;
$("empty-connect").onclick = connect;
for (const button of document.querySelectorAll(".close")) button.onclick = () => button.closest("dialog").close();
for (const dialog of document.querySelectorAll("dialog")) dialog.addEventListener("click", event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } });
$("endpoint").textContent = location.origin + "/mcp";
$("example").textContent = JSON.stringify({ method: "events/stream", params: { name: "galaxy.signal", arguments: { name: "Voyager", clientId: "your-random-unique-id" } } }, null, 2);
$("copy").onclick = async () => { try { await navigator.clipboard.writeText(location.origin + "/mcp"); $("copy").textContent = "Copied"; setTimeout(() => $("copy").textContent = "Copy", 2000); } catch { toast("Select the endpoint above to copy it."); } };
const prefersReducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
let paused = prefersReducedMotion;
function updateMotion() { document.body.classList.toggle("paused", paused); $("motion").setAttribute("aria-pressed", String(paused)); $("motion").setAttribute("aria-label", paused ? "Resume floating motion" : "Pause floating motion"); $("motion").textContent = paused ? "▷" : "Ⅱ"; }
$("motion").onclick = () => { paused = !paused; updateMotion(); };
updateMotion();

function compose(id) {
  intent.clear();
  const subscriber = subscribers.find(s => s.id === id);
  if (!subscriber) return toast("That little light has moved on.");
  if ($("compose").open) return;
  selected = subscriber; $("recipient").textContent = label(subscriber);
  $("message").value = ""; $("message-error").textContent = ""; countMessage(); $("compose").showModal(); $("message").focus();
}
function countMessage() {
  const count = [...$("message").value].length;
  $("remaining").textContent = count + " / 200";
  $("remaining").style.color = count > 200 ? "#ffb2b2" : "";
  $("send").disabled = count > 200 || !$("message").value.trim();
}
$("message").addEventListener("input", countMessage);
$("message-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!selected || $("send").disabled) return;
  $("send").disabled = true; $("message-error").textContent = "";
  try { await sendSignal(selected.id, "message", $("message").value); $("compose").close(); }
  catch (error) { $("message-error").textContent = error.message; countMessage(); }
});
async function sendSignal(id, kind, text) {
  const s = subscribers.find(s => s.id === id);
  if (!s || !online) { const error = new Error(online ? "That subscriber has left the galaxy." : "Connection lost. Wait for the galaxy to reconnect."); toast(error.message); throw error; }
  const body = { kind, ...(kind === "message" ? { text } : {}) };
  try {
    const response = await fetch("/api/subscribers/" + encodeURIComponent(id) + "/signals", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.retryAfterMs ? result.error + " Try again in " + Math.ceil(result.retryAfterMs / 1000) + "s." : result.error || "The signal could not be sent.");
    glow(id); toast(kind === "ping" ? "Ping sent to " + s.name + " ✧" : "Your note is on its way to " + s.name + ".");
    return result;
  } catch (error) { toast(error.message || "The signal could not be sent."); throw error; }
}
function glow(id) {
  const node = nodes.get(id);
  if (!node) return;
  node.classList.remove("sent"); void node.offsetWidth; node.classList.add("sent");
  setTimeout(() => node.classList.remove("sent"), 1600);
}
function render(data) {
  const previous = new Map(subscribers.map(s => [s.id, s]));
  subscribers = data.subscribers;
  serverNow = snapshotClock(data.serverTime ?? new Date().toISOString(), performance.now());
  $("count").textContent = subscribers.length;
  $("connection").textContent = subscribers.length ? subscribers.length + (subscribers.length === 1 ? " signal in orbit" : " signals in orbit") : "The galaxy is live";
  $("empty").hidden = subscribers.length > 0;
  $("roster-empty").hidden = subscribers.length > 0;
  $("roster-empty").textContent = "No listeners yet. The next one could be yours.";
  for (const [id, node] of nodes) if (!subscribers.some(s => s.id === id)) { intent.cancel(id); node.remove(); nodes.delete(id); }
  const list = document.createDocumentFragment();
  subscribers.forEach((s, index) => {
    const hash = [...s.id].reduce((n, c) => ((n * 31) + c.charCodeAt(0)) >>> 0, 0);
    const color = colors[hash % colors.length];
    let star = nodes.get(s.id);
    if (!star) {
      star = document.createElement("button"); star.className = "star";
      star.setAttribute("aria-label", "Ping " + label(s) + "; double-click to send a message");
      const core = document.createElement("span"); core.className = "star-core"; core.setAttribute("aria-hidden", "true");
      const ring = document.createElement("span"); ring.className = "freshness-ring"; core.append(ring);
      const orb = document.createElement("span"); orb.className = "star-orb"; orb.append(core);
      const name = document.createElement("span"); name.className = "star-name"; name.textContent = s.name;
      const tooltip = document.createElement("span"); tooltip.className = "star-tooltip"; tooltip.id = "presence-" + s.id; tooltip.setAttribute("role", "tooltip");
      star.setAttribute("aria-describedby", tooltip.id);
      star.append(orb, name, tooltip);
      star.addEventListener("click", event => intent.click(s.id, event.detail));
      star.addEventListener("dblclick", event => { event.preventDefault(); intent.cancel(s.id); compose(s.id); });
      $("stars").append(star); nodes.set(s.id, star);
    }
    const angle = index * 2.39996323 - Math.PI / 2;
    const radius = subscribers.length === 1 ? 0 : 13 + 30 * Math.sqrt(index / Math.max(1, subscribers.length - 1));
    star.style.left = (50 + Math.cos(angle) * radius) + "%"; star.style.top = (50 + Math.sin(angle) * radius * .83) + "%";
    star.style.setProperty("--color", color); star.style.setProperty("--size", (13 + hash % 8) + "px"); star.style.setProperty("--duration", (9 + hash % 8) + "s"); star.style.setProperty("--delay", -(hash % 10) + "s");
    if (previous.has(s.id) && previous.get(s.id).signalCount !== s.signalCount) glow(s.id);
    const li = document.createElement("li"); li.style.setProperty("--color", color);
    const dot = document.createElement("span"); dot.className = "dot";
    const button = document.createElement("button"); button.className = "name-button"; button.setAttribute("aria-label", "Ping " + label(s));
    const title = document.createElement("strong"); title.textContent = s.name;
    const detail = document.createElement("small"); detail.textContent = s.modes.join(" + ") || "reconnecting";
    detail.className = "presence-detail"; detail.dataset.subscriber = s.id;
    button.append(title, detail); button.onclick = event => intent.click(s.id, event.detail);
    button.ondblclick = event => { event.preventDefault(); intent.cancel(s.id); compose(s.id); };
    const message = document.createElement("button"); message.className = "message-button"; message.textContent = "✉"; message.setAttribute("aria-label", "Send a message to " + label(s)); message.onclick = () => compose(s.id);
    li.append(dot, button, message); list.append(li);
  });
  // Avoid replacing focused list controls during background refreshes.
  if (!$("subscribers").contains(document.activeElement)) $("subscribers").replaceChildren(list);
  paintFreshness();
}
function paintFreshness() {
  if (document.hidden || !polling) return;
  const now = serverNow(performance.now());
  const statuses = new Map();
  for (const s of subscribers) {
    const state = freshness(s.subscriptions, now);
    const node = nodes.get(s.id);
    if (!node) continue;
    const summary = online ? state.summary : "Status unknown · reconnecting";
    statuses.set(s.id, summary);
    node.style.setProperty("--freshness-scale", String(.3 + .7 * state.fraction));
    node.style.setProperty("--freshness-opacity", String(.15 + .65 * state.fraction));
    const tooltip = node.querySelector(".star-tooltip");
    const details = s.name + "\nID: " + s.id.slice(-4) + "\n" + (online ? state.details : "Connection lost; last known subscription state.");
    if (tooltip.textContent !== details) tooltip.textContent = details;
  }
  for (const detail of document.querySelectorAll(".presence-detail")) {
    const id = detail.dataset.subscriber;
    const value = statuses.get(id) ?? "left the galaxy";
    if (detail.textContent !== value) detail.textContent = value;
  }
}
async function refresh() {
  if (!polling) return;
  try {
    const response = await fetch("/api/subscribers", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("unavailable");
    const data = await response.json(); online = true; document.body.classList.remove("offline"); render(data);
  } catch {
    online = false; document.body.classList.add("offline"); $("connection").textContent = "Reconnecting to the galaxy";
    if (!subscribers.length) $("roster-empty").textContent = "Connection interrupted. Trying again…";
  } finally { if (polling) setTimeout(refresh, document.hidden ? 10_000 : 2000); }
}
window.addEventListener("pagehide", () => { polling = false; intent.clear(); clearInterval(freshnessTimer); });
window.addEventListener("pageshow", event => { if (event.persisted) { polling = true; refresh(); freshnessTimer = setInterval(paintFreshness, 250); } });
freshnessTimer = setInterval(paintFreshness, 250);
refresh();

// Optional browser-native tools use the same visible data and send action.
const context = document.modelContext;
if (context?.registerTool) {
  const lifecycle = new AbortController();
  const tool = (definition) => { try { Promise.resolve(context.registerTool(definition, { signal: lifecycle.signal })).catch(() => {}); } catch { /* Unsupported browser feature. */ } };
  tool({ name: "galaxy_list_subscribers", description: "Read the unverified public subscribers currently displayed in Signal Galaxy.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: true }, execute: () => ({ subscribers }) });
  tool({ name: "galaxy_send_signal", description: "Send an anonymous ping or text message to a displayed subscriber. This immediately sends an MCP event.", inputSchema: { type: "object", properties: { subscriberId: { type: "string" }, text: { type: "string", maxLength: 200 } }, required: ["subscriberId"], additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: true }, execute: async input => {
    if (!input || typeof input.subscriberId !== "string" || Object.keys(input).some(key => !["subscriberId", "text"].includes(key)) || (input.text !== undefined && (typeof input.text !== "string" || !input.text.trim() || [...input.text].length > 200))) throw new Error("Provide a subscriberId and optionally 1–200 characters of text.");
    return sendSignal(input.subscriberId, input.text === undefined ? "ping" : "message", input.text);
  } });
  window.addEventListener("pagehide", () => lifecycle.abort(), { once: true });
}
