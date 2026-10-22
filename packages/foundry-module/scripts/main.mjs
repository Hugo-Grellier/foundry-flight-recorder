// Foundry Flight Recorder: entry point. Settings, consent, session lifecycle, status badge, friction markers.
import { Recorder, RECORDER_VERSION } from "./recorder.mjs";
import { installCapture, emitSceneSummary } from "./capture.mjs";
import { installPerf } from "./perf.mjs";
import { emitEnvironment } from "./env.mjs";
import { installAdapters } from "./adapters/index.mjs";
import { pseudo, state, combatCtx } from "./util.mjs";

const MOD = "foundry-flight-recorder";
const get = (k) => game.settings.get(MOD, k);
let rec, perfSupports = {}, adapters = [], applying = Promise.resolve(), badge = null, askedFor = null;

const FRICTION = { confusing: "Confusing", difficult: "Hard to do", broken: "Broken / bug", slow: "Slow / laggy", rules: "Unsure about a rule", other: "Other" };

function registerSettings() {
  const reg = (k, o) => game.settings.register(MOD, k, { onChange: () => schedule(), ...o });
  reg("enabled", { name: "Enable flight recorder", hint: "Master switch (GM). Nothing is recorded unless a session is started AND each participant opts in.", scope: "world", config: true, type: Boolean, default: false });
  reg("endpoint", { name: "Collector ingest URL", hint: "e.g. https://foundry.example.org/ffr/v1/ingest . Must be HTTPS if Foundry is served over HTTPS.", scope: "world", config: true, type: String, default: "http://127.0.0.1:4318/v1/ingest" });
  reg("ingestKey", { name: "Collector ingest key", hint: "Append-only key, visible to every connected browser. It cannot read, export or delete data.", scope: "world", config: true, type: String, default: "" });
  reg("mode", { name: "Collection mode", hint: "normal: low overhead. detailed: generic clicks, focus, warnings, layer changes. diagnostic: everything (also auto-enabled for 60 s after an error, freeze or friction marker).", scope: "world", config: true, type: String, choices: { normal: "Normal", detailed: "Detailed", diagnostic: "Diagnostic" }, default: "normal" });
  reg("includeNames", { name: "Record entity names", hint: "Include actor/item/scene/window names (helps analysis). Off: ids and types only.", scope: "world", config: true, type: Boolean, default: true });
  reg("captureConsole", { name: "Capture console errors/warnings", hint: "Records console.error/warn messages and their origin module.", scope: "world", config: true, type: Boolean, default: true });
  reg("session", { scope: "world", config: false, type: Object, default: null });
  reg("participation", { name: "My participation in session recording", hint: "Ask: prompt when a recording starts. Yes/No: your choice for this world. You can change it at any time.", scope: "client", config: true, type: String, choices: { ask: "Ask me", yes: "Yes, record my client", no: "No, never record my client" }, default: "ask" });
  game.keybindings.register(MOD, "friction", {
    name: "Flight recorder: report friction", hint: "Mark the current moment as confusing, difficult or broken.",
    editable: [{ key: "KeyF", modifiers: ["Alt", "Shift"] }], onDown: () => { openFriction(); return true; },
  });
}

function schedule() { applying = applying.then(apply, apply); return applying; }

async function apply() {
  if (!game.ready) return;
  const enabled = get("enabled"), session = get("session"), endpoint = get("endpoint");
  state.includeNames = get("includeNames");
  if (!enabled || !session?.id || !endpoint) {
    if (rec.state === "active") rec.emit("rec.stop", { reason: enabled ? "no-session" : "disabled" });
    await rec.close(); // flush; undeliverable events are persisted for the next activation
    return renderBadge();
  }
  let participation = get("participation");
  if (participation === "ask" && askedFor !== session.id) {
    askedFor = session.id;
    participation = await askConsent(session);
    if (participation) await game.settings.set(MOD, "participation", participation); // re-enters apply via onChange
    return renderBadge();
  }
  if (participation !== "yes") { rec.disable(); try { localStorage.removeItem(`ffr.pending.${game.world.id}`); } catch {} return renderBadge(); } // opt-out: drop everything

  const fresh = rec.state !== "active" || rec.ident.sessionId !== session.id;
  if (rec.state === "active" && rec.ident.sessionId !== session.id) await rec.flush();
  rec.configure({ endpoint, key: get("ingestKey"), mode: get("mode"), sessionId: session.id, user: pseudo(game.world.id, game.user.id), role: game.user.isGM ? "gm" : "player", world: game.world.id });
  if (fresh) {
    rec.activate();
    rec.emit("rec.start", { session: session.id, label: session.label ?? null, version: RECORDER_VERSION, adapters, reload: performance.now() < 120000 });
    const nav = performance.getEntriesByType?.("navigation")?.[0];
    rec.emit("client.load", { readyMs: Math.round(performance.now()), domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : null, transferKb: nav ? Math.round(nav.transferSize / 1024) : null });
    emitEnvironment(rec, { mode: get("mode"), perfSupports, adapters });
    if (canvas?.scene) emitSceneSummary(rec, canvas.scene);
    rec.restore().catch(() => {});
    ui.notifications.info("Flight recorder: this session is being recorded (your client opted in). Alt+Shift+F reports friction.");
  }
  renderBadge();
}

async function askConsent(session) {
  const { DialogV2 } = foundry.applications.api;
  const content = `<p>The GM started a <b>session recording</b>${session.label ? ` (“${foundry.utils.escapeHTML(session.label)}”)` : ""} to improve future sessions.</p>
    <p>If you agree, your client sends to the GM's server: windows/tabs opened, buttons used, targets, token moves, rolls and their results,
    errors and performance measurements. <b>Never</b> chat text, typed text, passwords, journals, audio or screenshots.
    You are identified by a pseudonym. Data is used to improve the game, not to rate players.</p>
    <p>You can change this later in <i>Configure Settings → Flight Recorder</i> or with the REC badge.</p>`;
  const r = await DialogV2.wait({
    window: { title: "Session recording" }, content, rejectClose: false,
    buttons: [{ action: "yes", label: "Record my client", default: true }, { action: "no", label: "Do not record me" }],
  });
  return r === "yes" ? "yes" : r === "no" ? "no" : null;
}

// ---------------------------------------------------------------------------
function renderBadge() {
  if (!badge) {
    badge = document.createElement("div");
    badge.id = "ffr-badge";
    badge.setAttribute("role", "button");
    badge.tabIndex = 0;
    badge.addEventListener("click", () => openMenu());
    document.body.append(badge);
  }
  const session = get("session"), enabled = get("enabled");
  const s = rec.state === "active" ? "rec" : enabled && session?.id ? "optout" : "idle";
  badge.dataset.state = s;
  badge.textContent = s === "rec" ? `● REC${rec.effectiveMode() !== "normal" ? ` (${rec.effectiveMode()})` : ""}` : s === "optout" ? "○ REC (not you)" : "○ rec off";
  badge.title = s === "rec" ? "This session is recorded from your client. Click for options / report friction." : s === "optout" ? "A session is being recorded, but not from your client." : "Flight recorder idle.";
  badge.hidden = !enabled && !game.user.isGM;
}

async function openMenu() {
  const { DialogV2 } = foundry.applications.api;
  const session = get("session");
  const st = rec.status();
  const buttons = [];
  if (st.state === "active") buttons.push({ action: "friction", label: "Report friction" });
  buttons.push(get("participation") === "yes" ? { action: "optout", label: "Stop recording me" } : { action: "optin", label: "Record my client" });
  if (game.user.isGM) buttons.push(session?.id ? { action: "stop", label: "Stop session" } : { action: "start", label: "Start session" });
  buttons.push({ action: "close", label: "Close" });
  const lines = [
    `Session: <b>${session?.id ?? "none"}</b>${session?.label ? ` — ${foundry.utils.escapeHTML(session.label)}` : ""}`,
    `Client state: ${st.state}, mode ${st.effectiveMode}, queued ${st.queue}, sent ${st.sent}, dropped ${st.dropped}`,
    `Collector: ${st.lastStatus.ok === null ? "not contacted yet" : st.lastStatus.ok ? "OK" : `failing (HTTP ${st.lastStatus.status || "network"}), retry in ${Math.round(st.backoffMs / 1000)} s`}`,
  ];
  const r = await DialogV2.wait({ window: { title: "Flight recorder" }, content: `<p>${lines.join("<br>")}</p>`, buttons, rejectClose: false });
  if (r === "friction") openFriction();
  else if (r === "optout") await game.settings.set(MOD, "participation", "no");
  else if (r === "optin") await game.settings.set(MOD, "participation", "yes");
  else if (r === "start") await startSession();
  else if (r === "stop") await stopSession();
}

async function openFriction() {
  if (rec.state !== "active") return ui.notifications.warn("Flight recorder is not recording your client.");
  const t = Date.now();
  const recent = rec.recent(12);
  const { DialogV2 } = foundry.applications.api;
  const opts = Object.entries(FRICTION).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
  const res = await DialogV2.prompt({
    window: { title: "Report friction" },
    content: `<div class="form-group"><label>What happened?</label><select name="cat">${opts}</select></div>
      <div class="form-group"><label>Optional note (visible to the GM's analysis)</label><input type="text" name="note" maxlength="300"></div>`,
    ok: { label: "Mark", callback: (ev, button) => ({ cat: button.form.elements.cat.value, note: button.form.elements.note.value }) },
    rejectClose: false,
  });
  if (!res) return;
  const openApps = [...(foundry.applications.instances?.values() ?? [])].map((a) => a.constructor.name).slice(0, 12);
  rec.emit("friction.mark", { cat: res.cat, note: String(res.note ?? "").slice(0, 300) || null, markedAt: t, dialogMs: Date.now() - t, recent, openApps }, { sev: "notice", local: true });
  ui.notifications.info("Thanks, marked.");
}

async function startSession(label) {
  if (!game.user.isGM) return;
  label ??= await foundry.applications.api.DialogV2.prompt({
    window: { title: "Start session recording" }, content: `<input type="text" name="label" placeholder="Session label (optional)" maxlength="100">`,
    ok: { callback: (ev, button) => button.form.elements.label.value }, rejectClose: false,
  });
  if (label === null || label === undefined) return;
  if (!get("enabled")) await game.settings.set(MOD, "enabled", true);
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const id = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}-${Math.random().toString(36).slice(2, 6)}`;
  await game.settings.set(MOD, "session", { id, label: label || null, startedAt: Date.now() });
  await schedule();
  rec.emit("session.start", { label: label || null, gm: true });
}

async function stopSession() {
  if (!game.user.isGM) return;
  rec.emit("session.stop", { by: "gm" });
  await rec.flush(); // apply() -> rec.close() persists anything still undelivered
  await game.settings.set(MOD, "session", null);
}

// ---------------------------------------------------------------------------
Hooks.once("init", () => {
  registerSettings();
  rec = new Recorder({
    fetch: (u, i) => window.fetch(u, i),
    beacon: (u, body) => navigator.sendBeacon?.(u, new Blob([body], { type: "text/plain" })) ?? false,
    storage: window.localStorage, storageKey: `ffr.pending.${game.world?.id ?? "world"}`,
    context: () => ({ scene: globalThis.canvas?.scene?.id, combat: combatCtx() }),
  });
  state.worldId = game.world?.id ?? "";
  try { state.includeNames = get("includeNames"); rec.configure({ mode: get("mode") }); } catch { /* world settings not readable yet */ }
  if (!get("enabled")) rec.disable(); // nothing is buffered when the GM never enabled the recorder
  const safe = (fn) => function (...a) { try { fn.apply(this, a); } catch { rec.counters.selfErrors++; } };
  installCapture(rec, { captureConsole: get("captureConsole") });
  adapters = installAdapters(rec, safe);
  window.addEventListener("pagehide", () => { rec.emit("client.unload", {}); rec.unload(); });
  game.modules.get(MOD).api = { recorder: rec, start: startSession, stop: stopSession, friction: openFriction, status: () => rec.status(), mark: (cat = "other", note = null) => rec.emit("friction.mark", { cat, note, recent: rec.recent(12), api: true }, { sev: "notice", local: true }) };
});

Hooks.once("ready", () => {
  perfSupports = installPerf(rec);
  for (const a of adapters) rec.emit("rec.adapter", a, { sev: a.ok ? "info" : "warn" });
  schedule();
});
