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

const FRICTION = ["confusing", "difficult", "broken", "slow", "rules", "other"];
const L = (k, data) => (data ? game.i18n.format(`FFR.${k}`, data) : game.i18n.localize(`FFR.${k}`));
const S = (k) => ({ name: `FFR.Settings.${k}.name`, hint: `FFR.Settings.${k}.hint` }); // Foundry localizes these keys

function registerSettings() {
  const reg = (k, o) => game.settings.register(MOD, k, { onChange: () => schedule(), ...o });
  reg("enabled", { ...S("enabled"), scope: "world", config: true, type: Boolean, default: false });
  reg("endpoint", { ...S("endpoint"), scope: "world", config: true, type: String, default: "http://127.0.0.1:4318/v1/ingest" });
  reg("ingestKey", { ...S("ingestKey"), scope: "world", config: true, type: String, default: "" });
  reg("mode", { ...S("mode"), scope: "world", config: true, type: String, choices: { normal: "FFR.Mode.normal", detailed: "FFR.Mode.detailed", diagnostic: "FFR.Mode.diagnostic" }, default: "normal" });
  reg("includeNames", { ...S("includeNames"), scope: "world", config: true, type: Boolean, default: true });
  reg("captureConsole", { ...S("captureConsole"), scope: "world", config: true, type: Boolean, default: true });
  reg("session", { scope: "world", config: false, type: Object, default: null });
  reg("participation", { ...S("participation"), scope: "user", config: true, type: String, choices: { ask: "FFR.Participation.ask", yes: "FFR.Participation.yes", no: "FFR.Participation.no" }, default: "ask" });
  game.keybindings.register(MOD, "friction", {
    name: "FFR.Key.friction", hint: "FFR.Key.frictionHint",
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
    ui.notifications.info(L("Started"));
  }
  renderBadge();
}

async function askConsent(session) {
  const { DialogV2 } = foundry.applications.api;
  const content = L("Consent.body", { label: session.label ? ` (“${foundry.utils.escapeHTML(session.label)}”)` : "" });
  const r = await DialogV2.wait({
    window: { title: L("Consent.title") }, content, rejectClose: false,
    buttons: [{ action: "yes", label: L("Consent.yes"), default: true }, { action: "no", label: L("Consent.no") }],
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
  badge.textContent = L(`Badge.${s}`) + (s === "rec" && rec.effectiveMode() !== "normal" ? ` (${L(`Mode.${rec.effectiveMode()}`)})` : "");
  badge.title = L(`Badge.${s}Tip`);
  badge.hidden = !enabled && !game.user.isGM;
}

async function openMenu() {
  const { DialogV2 } = foundry.applications.api;
  const session = get("session");
  const st = rec.status();
  const buttons = [];
  const btn = (action) => ({ action, label: L(`Menu.${action}`) });
  if (st.state === "active") buttons.push(btn("friction"));
  buttons.push(btn(get("participation") === "yes" ? "optout" : "optin"));
  if (game.user.isGM) buttons.push(btn(session?.id ? "stop" : "start"));
  buttons.push(btn("close"));
  const lines = [
    `${L("Menu.session")} : <b>${session?.id ?? L("Menu.none")}</b>${session?.label ? ` — ${foundry.utils.escapeHTML(session.label)}` : ""}`,
    L("Menu.client", { state: st.state, mode: st.effectiveMode, queue: st.queue, sent: st.sent, dropped: st.dropped }),
    `${L("Menu.collector")} : ${st.lastStatus.ok === null ? L("Menu.notContacted") : st.lastStatus.ok ? L("Menu.ok") : L("Menu.failing", { status: st.lastStatus.status || "network", s: Math.round(st.backoffMs / 1000) })}`,
  ];
  const r = await DialogV2.wait({ window: { title: L("Menu.title") }, content: `<p>${lines.join("<br>")}</p>`, buttons, rejectClose: false });
  if (r === "friction") openFriction();
  else if (r === "optout") await game.settings.set(MOD, "participation", "no");
  else if (r === "optin") await game.settings.set(MOD, "participation", "yes");
  else if (r === "start") await startSession();
  else if (r === "stop") await stopSession();
}

async function openFriction() {
  if (rec.state !== "active") return ui.notifications.warn(L("Friction.notRecording"));
  const t = Date.now();
  const recent = rec.recent(12);
  const { DialogV2 } = foundry.applications.api;
  const opts = FRICTION.map((k) => `<option value="${k}">${L(`Friction.${k}`)}</option>`).join("");
  const res = await DialogV2.prompt({
    window: { title: L("Friction.title") },
    content: `<div class="form-group"><label>${L("Friction.what")}</label><select name="cat">${opts}</select></div>
      <div class="form-group"><label>${L("Friction.note")}</label><input type="text" name="note" maxlength="300"></div>`,
    ok: { label: L("Friction.mark"), callback: (ev, button) => ({ cat: button.form.elements.cat.value, note: button.form.elements.note.value }) },
    rejectClose: false,
  });
  if (!res) return;
  const openApps = [...(foundry.applications.instances?.values() ?? [])].map((a) => a.constructor.name).slice(0, 12);
  rec.emit("friction.mark", { cat: res.cat, note: String(res.note ?? "").slice(0, 300) || null, markedAt: t, dialogMs: Date.now() - t, recent, openApps }, { sev: "notice", local: true });
  ui.notifications.info(L("Friction.thanks"));
}

async function startSession(label) {
  if (!game.user.isGM) return;
  label ??= await foundry.applications.api.DialogV2.prompt({
    window: { title: L("Start.title") }, content: `<input type="text" name="label" placeholder="${L("Start.label")}" maxlength="100">`,
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

Hooks.once("ready", async () => {
  // 0.1.0 kept the choice per browser (client scope); carry it over to the account (user scope) once.
  try {
    const legacy = JSON.parse(localStorage.getItem(`${MOD}.participation`) ?? "null");
    if (["yes", "no"].includes(legacy) && get("participation") === "ask") await game.settings.set(MOD, "participation", legacy);
    localStorage.removeItem(`${MOD}.participation`);
  } catch { /* nothing to migrate */ }
  perfSupports = installPerf(rec);
  for (const a of adapters) rec.emit("rec.adapter", a, { sev: a.ok ? "info" : "warn" });
  schedule();
});
