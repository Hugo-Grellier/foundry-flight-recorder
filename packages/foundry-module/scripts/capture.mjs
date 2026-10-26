// Passive Foundry/browser capture. Every handler is wrapped so a failure here can never
// propagate into Foundry or another module, and no handler returns a value (never vetoes a hook).
import { originsFromStack, errorFingerprint, topOrigin } from "./schema.mjs";
import { ref, appFor, appName, appRef, changedPaths, isActiveGM, isSelf, userRef, state } from "./util.mjs";

const IDLE_MS = 90000;

// Adapters push (el, app, data) => void functions here to add system semantics to ui.action events.
export const actionEnrichers = [];

export function installCapture(rec, opts) {
  const safe = (fn) => function (...args) { try { fn.apply(this, args); } catch { rec.counters.selfErrors++; } };
  const on = (hook, fn) => Hooks.on(hook, safe(fn));

  installErrors(rec, safe, on, opts);
  installNotifications(rec, safe);
  installUi(rec, safe, on);
  installCanvas(rec, on);
  installDocuments(rec, on);
  installChat(rec, on);
  installCombat(rec, on);
  installNetwork(rec, safe, on);
}

// ---------------------------------------------------------------------------
function errData(msg, stack, extra = {}) {
  const origins = originsFromStack(stack);
  const versions = {};
  for (const o of origins) {
    const pkg = o.startsWith("system:") ? (game.system?.id === o.slice(7) ? game.system : null) : game.modules?.get(o);
    if (pkg?.version) versions[o] = pkg.version;
  }
  const top = topOrigin(stack);
  return { msg: String(msg ?? "").slice(0, 500), stack, top, origins, versions, fp: errorFingerprint(msg, top ?? origins[0]), ...extra };
}

function installErrors(rec, safe, on, opts) {
  let last = { msg: null, t: 0 };
  const seen = (msg) => {
    const now = Date.now();
    const dup = msg === last.msg && now - last.t < 2000;
    last = { msg, t: now };
    return dup;
  };
  window.addEventListener("error", safe((ev) => {
    const msg = ev.message ?? ev.error?.message ?? "error";
    if (seen(msg)) return;
    // Resource load errors (img/audio) have no message: record the element type only.
    rec.emit("err.js", errData(msg, ev.error?.stack ?? "", { file: String(ev.filename ?? "").replace(/^https?:\/\/[^/]+/, ""), line: ev.lineno, col: ev.colno }), { sev: "error" });
  }), true);
  window.addEventListener("unhandledrejection", safe((ev) => {
    const r = ev.reason;
    const msg = r?.message ?? String(r);
    if (seen(msg)) return;
    rec.emit("err.promise", errData(msg, r?.stack ?? "", { name: r?.name }), { sev: "error" });
  }));
  on("error", (location, error, data) => {
    if (seen(error?.message)) return;
    rec.emit("err.foundry", errData(error?.message, error?.stack ?? "", { location: String(location).slice(0, 120), dataKeys: Object.keys(data ?? {}).slice(0, 10) }), { sev: "error" });
  });

  if (!opts.captureConsole) return;
  // Wrap console.error/warn: call the original first, then record. Reentrancy is blocked by
  // Recorder.emit, and the recorder itself never logs through console.error.
  for (const [level, type] of [["error", "err.console"], ["warn", "warn.console"]]) {
    const orig = console[level];
    console[level] = function (...args) {
      orig.apply(this, args);
      try {
        const errArg = args.find((a) => a instanceof Error);
        const msg = args.map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : a?.constructor?.name ?? typeof a)).join(" ").slice(0, 500);
        if (level === "error" && seen(msg)) return;
        // stack: the error's own, else the call site (only for errors: costs an Error allocation)
        const stack = errArg?.stack ?? (level === "error" ? new Error().stack?.split("\n").slice(2).join("\n") : "");
        rec.emit(type, errData(msg, stack ?? ""), { sev: level === "error" ? "error" : "warn" });
      } catch { /* never throw from console */ }
    };
  }
}

// ui.notifications renders <li class="notification {type}"> into <ol id="notifications">; observe it.
function installNotifications(rec, safe) {
  const attach = () => {
    const ol = document.getElementById("notifications");
    if (!ol) return false;
    new MutationObserver(safe((muts) => {
      for (const m of muts) for (const n of m.addedNodes) {
        if (!(n instanceof HTMLElement) || !n.classList.contains("notification")) continue;
        const kind = ["error", "warning", "success", "info"].find((c) => n.classList.contains(c)) ?? "info";
        rec.emit("ui.notify", { kind, msg: (n.innerText ?? "").trim().slice(0, 300) },
          { sev: kind === "error" ? "error" : kind === "warning" ? "warn" : "info", lvl: kind === "info" || kind === "success" ? 1 : 0 });
      }
    })).observe(ol, { childList: true });
    return true;
  };
  if (!attach()) Hooks.once("ready", () => attach());
}

// ---------------------------------------------------------------------------
function installUi(rec, safe, on) {
  const spans = new Map(); // app instance -> span
  // Only real windows: framed AppV2 / pop-out AppV1. Frameless persistent UI (sidebar, players,
  // hotbar, HUD panels) re-renders constantly and is not a user "opening" anything.
  const isWindow = (app) => (app instanceof foundry.applications.api.ApplicationV2 ? app.hasFrame !== false : app?.popOut !== false);
  const open = (app) => {
    if (spans.has(app) || !isWindow(app)) return;
    spans.set(app, rec.span("ui.app", appRef(app), { type: "ui.app.open", local: true }));
  };
  const close = (app) => {
    const s = spans.get(app);
    if (!s) return;
    spans.delete(app);
    s.end("closed", { cls: appName(app) }, { type: "ui.app.close" });
  };
  on("renderApplicationV2", (app, el, ctx, options) => { if (options?.isFirstRender !== false) open(app); });
  on("closeApplicationV2", (app) => close(app));
  // AppV1 hooks fire per class of the inheritance chain, but in V14 the chain of V1 document sheets
  // stops at e.g. ActorSheet (verified: PF2e CharacterSheetPF2e fires renderActorSheet, not renderApplication).
  for (const base of ["Application", "FormApplication", "DocumentSheet", "ActorSheet", "ItemSheet", "JournalSheet", "Dialog"]) {
    on(`render${base}`, (app) => open(app));
    on(`close${base}`, (app) => close(app));
  }

  on("changeSidebarTab", (app) => rec.emit("ui.sidebar", { tab: app?.tabName ?? app?.id ?? String(app) }, { local: true }));
  on("activateCanvasLayer", (layer) => rec.emit("ui.layer", { layer: layer?.options?.name ?? layer?.constructor?.name }, { local: true }));

  // Delegated, capture-phase, passive: tabs, actions, generic clicks. Records structure, never text input.
  document.addEventListener("click", safe((ev) => {
    const el = ev.target instanceof Element ? ev.target : null;
    if (!el || el.closest("#ffr-badge")) return;
    if (el.id === "board" || el.tagName === "CANVAS") return; // canvas interactions are captured semantically
    const app = appFor(el);
    const cls = appName(app);
    const tab = el.closest("[data-tab]");
    if (tab && tab.closest("nav, .tabs, [data-group]")) {
      rec.emit("ui.tab", { tab: tab.dataset.tab, group: tab.dataset.group ?? null, cls }, { local: true });
      return;
    }
    const act = el.closest("[data-action]");
    if (act) {
      const data = { action: act.dataset.action, cls };
      const itemEl = act.closest("[data-item-id], [data-item-uuid]");
      const doc = app?.document ?? app?.actor;
      const item = itemEl && (itemEl.dataset.itemUuid ? fromUuidSync?.(itemEl.dataset.itemUuid) : doc?.items?.get?.(itemEl.dataset.itemId));
      if (item) data.item = ref(item);
      if (act.dataset.slug) data.slug = act.dataset.slug;
      if (act.dataset.statistic) data.statistic = act.dataset.statistic;
      for (const f of actionEnrichers) { try { f(act, app, data); } catch { rec.counters.selfErrors++; } }
      rec.emit("ui.action", data, { local: true });
      return;
    }
    const target = el.closest("button, a, [role=button], li[data-document-id], .directory-item, input[type=checkbox]") ?? el;
    rec.emit("ui.click", {
      tag: target.tagName.toLowerCase(), cls, classes: [...target.classList].slice(0, 3).join(" "),
      tooltip: target.dataset?.tooltip?.slice(0, 80) ?? null, docId: target.dataset?.documentId ?? target.dataset?.entryId ?? null,
    }, { local: true });
  }), { capture: true, passive: true });

  document.addEventListener("focusin", safe((ev) => {
    const el = ev.target;
    if (!(el instanceof HTMLElement) || !el.matches("input, textarea, select, [contenteditable=true], prose-mirror")) return;
    if (el.type === "password") return;
    const field = el.closest("#chat-message, .chat-form") ? "chat-message" : (el.name || el.dataset?.edit || el.tagName.toLowerCase()).slice(0, 80);
    rec.emit("ui.focus", { field, kind: el.type ?? el.tagName.toLowerCase(), cls: appName(appFor(el)) }, { local: true });
  }), { capture: true, passive: true });

  // Inactivity: an idle span opens after IDLE_MS without input and closes on the next input.
  let lastInput = Date.now(), idle = null;
  const activity = () => {
    lastInput = Date.now();
    if (idle) { idle.end("active", {}, { type: "client.idle" }); idle = null; }
  };
  for (const t of ["pointerdown", "keydown", "wheel", "pointermove"]) document.addEventListener(t, activity, { capture: true, passive: true });
  setInterval(safe(() => {
    if (!idle && Date.now() - lastInput > IDLE_MS) idle = rec.span("client.idle", { afterMs: IDLE_MS, hidden: document.hidden }, { type: "client.idle", local: true });
  }), 15000);
  document.addEventListener("visibilitychange", safe(() => rec.emit("client.visibility", { state: document.visibilityState }, { local: true })));
}

// ---------------------------------------------------------------------------
function installCanvas(rec, on) {
  let load = null;
  const summarized = new Set();
  on("canvasInit", (c) => {
    load?.end("superseded");
    load = rec.span("scene.load", { scene: c?.scene?.id ?? null }, { type: "scene.load", scene: c?.scene?.id, local: true });
  });
  on("canvasReady", (c) => {
    const scene = c?.scene;
    load?.end("ready", { scene: scene?.id ?? null }, { scene: scene?.id });
    load = null;
    if (scene && !summarized.has(scene.id)) { summarized.add(scene.id); emitSceneSummary(rec, scene); }
  });
  on("canvasTearDown", (c) => rec.emit("scene.teardown", { scene: c?.scene?.id ?? null }, { local: true }));

  on("controlToken", (token, controlled) => rec.emit("token.control", { token: ref(token?.document), actor: ref(token?.actor), controlled: !!controlled }, { local: true }));
  on("targetToken", (user, token, targeted) => {
    if (!user?.isSelf) return;
    rec.emit("token.target", { token: ref(token?.document), actor: ref(token?.actor), targeted: !!targeted, nTargets: user.targets?.size ?? null, disposition: token?.document?.disposition ?? null }, { local: true });
  });
  on("moveToken", (doc, movement, operation, user) => {
    if (!user?.isSelf) return;
    const p = movement?.passed ?? {};
    rec.emit("token.move", {
      token: ref(doc), actor: ref(doc?.actor), waypoints: p.waypoints?.length ?? null, distance: p.distance ?? null,
      cost: p.cost ?? null, method: movement?.method ?? null, constrained: !!movement?.constrained,
    }, { local: true });
  });
}

export function emitSceneSummary(rec, scene) {
  const n = (c) => c?.size ?? c?.length ?? 0;
  rec.emit("scene.summary", {
    scene: scene.id, name: state.includeNames ? scene.name : undefined,
    width: scene.width, height: scene.height, gridSize: scene.grid?.size, gridType: scene.grid?.type,
    tokenVision: scene.tokenVision, fog: scene.fog?.exploration ?? null,
    globalLight: scene.environment?.globalLight?.enabled ?? null, darkness: scene.environment?.darknessLevel ?? null,
    counts: { tokens: n(scene.tokens), lights: n(scene.lights), walls: n(scene.walls), tiles: n(scene.tiles),
      sounds: n(scene.sounds), regions: n(scene.regions), drawings: n(scene.drawings), notes: n(scene.notes), levels: n(scene.levels) },
    visionTokens: scene.tokens?.filter?.((t) => t.sight?.enabled).length ?? null,
    animatedLights: scene.lights?.filter?.((l) => l.config?.animation?.type).length ?? null,
  }, { scene: scene.id, local: true });
}

// ---------------------------------------------------------------------------
const DOC_TYPES = ["Actor", "Item", "ActiveEffect", "Token", "Combatant", "Macro", "Scene", "JournalEntry", "Playlist", "RollTable"];
const HP = "system.attributes.hp";

function installDocuments(rec, on) {
  for (const T of DOC_TYPES) {
    on(`create${T}`, (doc, options, userId) => {
      if (!isSelf(userId)) return;
      rec.emit("doc.create", { doc: ref(doc), parent: ref(doc?.parent) }, { local: true });
    });
    on(`update${T}`, (doc, change, options, userId) => {
      if (!isSelf(userId)) return;
      const paths = changedPaths(change);
      const hp = foundry.utils.getProperty(change, HP);
      const data = { doc: ref(doc), parent: ref(doc?.parent), paths };
      if (hp) data.hp = { value: hp.value ?? null, temp: hp.temp ?? null, max: doc?.system?.attributes?.hp?.max ?? null };
      if (options?.diff === false) data.full = true;
      // movement updates are captured by moveToken; HP changes are always worth recording
      rec.emit("doc.update", data, { local: true, lvl: hp ? 0 : 1 });
    });
    on(`delete${T}`, (doc, options, userId) => {
      if (!isSelf(userId)) return;
      rec.emit("doc.delete", { doc: ref(doc), parent: ref(doc?.parent) }, { local: true });
    });
  }
}

// ---------------------------------------------------------------------------
export function rollData(roll) {
  try {
    return {
      formula: String(roll.formula ?? "").slice(0, 120), total: Number.isFinite(roll.total) ? roll.total : null,
      dice: (roll.dice ?? []).slice(0, 8).map((d) => ({ f: d.faces, n: d.number, r: (d.results ?? []).slice(0, 20).map((x) => x.result) })),
      cls: roll.constructor?.name,
    };
  } catch { return null; }
}

function installChat(rec, on) {
  on("createChatMessage", (msg, options, userId) => {
    const local = isSelf(userId);
    if (!local && !isActiveGM()) return; // the active GM records others' messages once (dk dedups)
    const sp = msg.speaker ?? {};
    rec.emit("chat.message", {
      msg: msg.id, style: msg.style ?? msg.type ?? null, isRoll: !!msg.isRoll, rolls: (msg.rolls ?? []).slice(0, 5).map(rollData),
      whisper: msg.whisper?.length ?? 0, blind: !!msg.blind, author: userRef(msg.author),
      speaker: { actor: sp.actor ?? null, token: sp.token ?? null, alias: state.includeNames ? sp.alias ?? null : undefined },
      flagScopes: Object.keys(msg.flags ?? {}).slice(0, 10), // which modules decorated the message (no values)
    }, { local, dk: `chat:${msg.id}` });
  });
}

// ---------------------------------------------------------------------------
function installCombat(rec, on) {
  let turn = null; // open turn span (active GM only)
  const combatantData = (c) => c ? { combatant: c.id, actor: ref(c.actor), token: c.tokenId ?? null, pc: !!c.hasPlayerOwner, defeated: !!c.isDefeated, initiative: c.initiative } : null;
  const endTurn = (out) => { turn?.end(out, {}, { type: "combat.turn" }); turn = null; };

  on("combatStart", (combat) => {
    if (!isActiveGM()) return;
    rec.emit("combat.start", { combat: combat.id, combatants: combat.combatants.size, pcs: combat.combatants.filter((c) => c.hasPlayerOwner).length },
      { dk: `combat:${combat.id}:start`, combat: { id: combat.id, round: 1, turn: 0 } });
  });
  on("combatRound", (combat, update) => {
    if (!isActiveGM()) return;
    rec.emit("combat.round", { combat: combat.id, round: update?.round }, { dk: `combat:${combat.id}:r${update?.round}` });
  });
  on("combatTurnChange", (combat, prior, current) => {
    if (!isActiveGM()) return;
    endTurn("next");
    if (!current || current.round < 1) return;
    const c = combat.combatants.get(current.combatantId);
    const cc = { id: combat.id, round: current.round, turn: current.turn };
    turn = rec.span("combat.turn", { ...combatantData(c), round: current.round, turn: current.turn, prior: prior ? { round: prior.round, turn: prior.turn } : null },
      { type: "combat.turn", combat: cc, dk: `turn:${combat.id}:${current.round}:${current.turn}` });
  });
  on("deleteCombat", (combat) => {
    if (!isActiveGM()) return;
    endTurn("combat-ended");
    rec.emit("combat.end", { combat: combat.id, rounds: combat.round, started: !!combat.started }, { dk: `combat:${combat.id}:end` });
  });
}

// ---------------------------------------------------------------------------
function installNetwork(rec, safe, on) {
  window.addEventListener("online", safe(() => rec.emit("net.online", { online: true })));
  window.addEventListener("offline", safe(() => rec.emit("net.online", { online: false }, { sev: "warn" })));
  on("userConnected", (user, connected) => {
    if (!isActiveGM()) return;
    rec.emit("user.connection", { ...userRef(user), connected: !!connected }, { dk: `conn:${user.id}:${connected}:${Math.floor(Date.now() / 5000)}` });
  });
  Hooks.once("ready", () => {
    const s = game.socket;
    if (!s?.on) return;
    s.on("disconnect", safe((reason) => rec.emit("net.socket", { state: "disconnect", reason: String(reason ?? "") }, { sev: "warn" })));
    s.on("connect", safe(() => rec.emit("net.socket", { state: "connect" })));
    s.io?.on?.("reconnect_attempt", safe((n) => rec.emit("net.socket", { state: "reconnect_attempt", attempt: n }, { lvl: 1 })));
    s.io?.on?.("reconnect", safe(() => rec.emit("net.socket", { state: "reconnect" })));
    s.io?.on?.("reconnect_failed", safe(() => rec.emit("net.socket", { state: "reconnect_failed" }, { sev: "error" })));
  });
}
