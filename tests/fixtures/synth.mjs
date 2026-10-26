#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// Synthetic PF2e session generator. Drives the REAL Recorder (packages/foundry-module/scripts/recorder.mjs)
// for 4 simulated clients with skewed clocks, through schema validation, into the REAL Store.
// Event payload shapes mirror capture.mjs / adapters/pf2e.mjs. Returns ground truth for tests.
// Usage: node tests/fixtures/synth.mjs --db ./data/fixture.db
import { Recorder } from "../../packages/foundry-module/scripts/recorder.mjs";
import { validateBatch } from "../../packages/schema/schema.mjs";
import { openDb, Store } from "../../packages/analysis-cli/db.mjs";

const DAY = 86400000;

class World {
  constructor(store, t0) { this.store = store; this.V = t0; this.t0 = t0; this.clients = []; this.lost = 0; }
  at(sec) { this.tick(this.t0 + sec * 1000); }
  // advance virtual time, emitting perf windows every 10 s for every live client
  tick(target) {
    while (this.V < target) {
      const next = Math.min(target, Math.floor(this.V / 10000) * 10000 + 10000);
      this.V = next;
      if (next % 10000 === 0) for (const c of this.clients) if (c.alive && c.rec.state === "active") c.perfWindow();
    }
  }
  async flush() { for (const c of this.clients) if (c.alive) await c.rec.flush(); }
}

class Client {
  constructor(w, { name, user, role, skew = 0, mode = "normal", maxQueue }) {
    Object.assign(this, { w, name, user, role, skew, alive: true, down: false, ctx: {}, fps: 58, p95: 22 });
    this.rec = new Recorder({
      now: () => w.V + skew, mono: () => w.V - w.t0, setTimer: () => ({}), clearTimer: () => {},
      context: () => this.ctx, maxQueue,
      // Stands in for "file written on the Foundry server, imported later" (receive time = write time).
      send: async (body) => {
        if (this.down || !this.alive) return { ok: false, status: 0 };
        const b = JSON.parse(body);
        const v = validateBatch(b);
        if (!v.ok) return { ok: false, status: 400 };
        w.store.ingest(v.batch, { recv: w.V + 40, rejected: v.rejected.length });
        return { ok: true, status: 200 };
      },
    });
    this.rec.configure({ user, role, world: "pf2e-synth", mode });
    w.clients.push(this);
  }
  join(sessionId, { sceneMs = 3500, scene = "scCrypt", env }) {
    this.rec.configure({ sessionId });
    this.rec.activate();
    this.e("rec.start", { session: sessionId, version: "0.1.0", adapters: [{ id: "pf2e", ok: true }] });
    this.e("client.load", { readyMs: 9000 + sceneMs });
    this.e("env.snapshot", { foundry: { version: "14.369", generation: 14 }, system: { id: "pf2e", version: env.system }, nModules: Object.keys(env.modules).length, fp: { all: env.fp }, browser: { brands: [this.role === "gm" ? "Chromium 140" : "Firefox 141"], cores: this.name === "p2" ? 4 : 8 }, gpu: { renderer: this.name === "p2" ? "Intel UHD 620" : "NVIDIA RTX 3060" }, perfSupports: { loaf: true, longtask: true }, recorder: { version: "0.1.0", mode: "normal" } }, { local: true });
    this.e("env.modules", { modules: env.modules }, { local: true });
    this.e("env.settings", { settings: env.settings }, { local: true });
    this.loadScene(scene, sceneMs);
  }
  loadScene(scene, ms) {
    const s = this.rec.span("scene.load", { scene }, { type: "scene.load", scene, local: true });
    this.w.V += ms; // scene load blocks this client only; other clients' events are interleaved by tc anyway
    this.ctx.scene = scene;
    s.end("ready", { scene }, { scene });
    this.w.V -= ms;
    this.e("scene.summary", { scene, name: scene === "scCrypt" ? "Crypt of the Lich" : "Village", width: 4000, height: 3000, tokenVision: true, counts: { tokens: 14, lights: 23, walls: 410 }, animatedLights: 9 }, { scene, local: true });
  }
  e(type, data = {}, opts = {}) { return this.rec.emit(type, data, { local: true, ...opts }); }
  perfWindow() {
    const jitter = Math.sin(this.w.V / 7e4) * 3;
    this.e("perf.window", { windowMs: 10000, frames: Math.round((this.fps + jitter) * 10), fps: Math.round(this.fps + jitter), p50: 16.7, p95: this.p95, p99: this.p95 * 1.6, max: this.p95 * 2.5, longTasks: { n: 1, ms: 80 }, loaf: { n: 2, ms: 180, topOrigins: this.fps < 35 ? { fxmaster: 120 } : { "system:pf2e": 60 } }, heapMb: 640 });
  }
  openApp(cls, doc) { return this.rec.span("ui.app", { cls, appId: cls + Math.random().toString(36).slice(2, 5), doc }, { type: "ui.app.open", local: true }); }
  close(span) { span.end("closed", { cls: "x" }, { type: "ui.app.close" }); }
}

const ref = (doc, type, name, slug) => ({ uuid: `Actor.${name.toLowerCase()}000000000`.slice(0, 22), doc, type, name, slug, pc: type === "character" });
const KYRA = ref("Actor", "character", "Kyra"), EZREN = ref("Actor", "character", "Ezren"), VALEROS = ref("Actor", "character", "Valeros"), GOB = ref("Actor", "npc", "Goblin Warrior");
const ARC = { uuid: "Actor.ezren.Item.arc", doc: "Item", type: "spell", name: "Electric Arc", slug: "electric-arc" };

const ENV_A = {
  system: "8.6.1", fp: "fpA",
  modules: { "dice-so-nice": "5.2.1", fxmaster: "6.0.3", "pf2e-toolbelt": "2.1.0", "lib-wrapper": "1.13.2", socketlib: "1.1.2" },
  settings: { "core.visionAnimation": true, "core.maxFPS": 60, "pf2e.automation.flankingDetection": true, "fxmaster.enable": true },
};
const ENV_B = {
  system: "8.6.1", fp: "fpB",
  modules: { "dice-so-nice": "5.2.1", "pf2e-toolbelt": "2.2.0", "lib-wrapper": "1.13.2", socketlib: "1.1.2", "pf2e-target-helper": "1.0.0" },
  settings: { "core.visionAnimation": false, "core.maxFPS": 60, "pf2e.automation.flankingDetection": true },
};

/**
 * One session. variant "A": problems (targeting struggle, injected error, stall, disconnect, storage outage).
 * variant "B": after config changes; smoother.
 */
async function session(store, { id, t0, variant }) {
  const w = new World(store, t0);
  const truth = { session: id };
  const env = variant === "A" ? ENV_A : ENV_B;
  const gm = new Client(w, { name: "gm", user: "u_gm", role: "gm" });
  const p1 = new Client(w, { name: "p1", user: "u_kyra", role: "player", skew: -1500, mode: "normal", maxQueue: variant === "A" ? 40 : undefined });
  const p2 = new Client(w, { name: "p2", user: "u_ezren", role: "player", skew: 90000 }); // clock 90 s fast
  const p3 = new Client(w, { name: "p3", user: "u_valeros", role: "player", skew: -4000 });
  if (variant === "A") { p2.fps = 31; p2.p95 = 48; } else { p2.fps = 52; p2.p95 = 24; }

  gm.join(id, { env });
  gm.e("session.start", { label: variant === "A" ? "Session 1 - Crypt" : "Session 2 - Crypt (after fixes)", gm: true });
  w.at(20); p1.join(id, { env });
  w.at(35); p2.join(id, { env, sceneMs: variant === "A" ? 12500 : 6000 });
  w.at(50); p3.join(id, { env });
  await w.flush();

  // --- exploration: p1 looks through the spell list repeatedly
  w.at(120);
  const sheet1 = p1.openApp("CharacterSheetPF2e", KYRA);
  for (const [i, tab] of ["spellcasting", "actions", "spellcasting", "inventory", "spellcasting"].entries()) { w.at(125 + i * 8); p1.e("ui.tab", { tab, group: "primary", cls: "CharacterSheetPF2e" }); }
  w.at(170); p1.close(sheet1);
  w.at(200); p3.e("token.move", { token: { uuid: "Scene.scCrypt.Token.val" }, actor: VALEROS, waypoints: 1, distance: 30 });
  // p3 goes idle 6.5 min (tab hidden)
  w.at(220); p3.e("client.visibility", { state: "hidden" });
  const idle = p3.rec.span("client.idle", { afterMs: 90000, hidden: true }, { type: "client.idle", local: true });
  w.at(610); idle.end("active", {}, { type: "client.idle" }); p3.e("client.visibility", { state: "visible" });
  await w.flush();

  // --- combat
  const combat = { id: "cbt1" };
  w.at(600);
  gm.e("combat.start", { combat: "cbt1", combatants: 4, pcs: 3 }, { local: undefined, dk: "combat:cbt1:start" });
  let tt = 600;
  const turn = async (round, idx, actor, pc, durS, body) => {
    const cc = { id: "cbt1", round, turn: idx };
    for (const c of w.clients) c.ctx.combat = cc;
    w.at(tt);
    const s = gm.rec.span("combat.turn", { combatant: `cb${idx}`, actor, pc, round, turn: idx }, { type: "combat.turn", combat: cc, dk: `turn:cbt1:${round}:${idx}` });
    if (pc && actor.name === "Ezren") truth[`turnR${round}Ezren`] = s.id;
    await body?.(tt);
    tt += durS;
    w.at(tt);
    s.end("next", {}, { type: "combat.turn" });
    await w.flush();
  };
  const check = (c, data, msgId) => {
    c.e("pf2e.check", data, { dk: `pf2e:${msgId}` });
    if (c !== gm) gm.e("pf2e.check", data, { local: false, dk: `pf2e:${msgId}` }); // GM observes the same message
    c.e("chat.message", { msg: msgId, isRoll: true, rolls: [{ formula: "1d20+7", total: data.roll?.total ?? 15 }] }, { dk: `chat:${msgId}` });
  };

  for (let round = 1; round <= 3; round++) {
    gm.e("combat.round", { combat: "cbt1", round }, { dk: `combat:cbt1:r${round}` });
    await turn(round, 0, KYRA, true, round === 2 ? 45 : 50, async (t) => {
      w.at(t + 10); p1.e("token.target", { token: { uuid: "Scene.scCrypt.Token.gob1" }, actor: GOB, targeted: true, nTargets: 1 });
      if (variant === "A" && round === 2) {
        // context that only the ring buffer holds (detailed-level), then the injected error
        w.at(t + 15); p1.e("ui.click", { tag: "button", cls: "CharacterSheetPF2e", classes: "toolbelt-share" });
        w.at(t + 16); p1.e("ui.focus", { field: "system.resources.heroPoints.value", kind: "number", cls: "CharacterSheetPF2e" });
        w.at(t + 17);
        const err = p1.e("err.js", { msg: "Cannot read properties of undefined (reading 'actor')", stack: "TypeError: Cannot read properties of undefined (reading 'actor')\n    at onShare (http://foundry/modules/pf2e-toolbelt/scripts/main.js:1:4521)\n    at HTMLButtonElement.<anonymous> (http://foundry/modules/pf2e-toolbelt/scripts/main.js:1:4402)", top: "pf2e-toolbelt", origins: ["pf2e-toolbelt"], versions: { "pf2e-toolbelt": "2.1.0" }, fp: "pf2e-toolbelt|Cannot read properties of undefined (reading <s>)" }, { sev: "error" });
        truth.errorId = err.id;
        w.at(t + 18); p1.e("ui.notify", { kind: "error", msg: "An error occurred. See the console (F12)." }, { sev: "error" });
      }
      w.at(t + 30); check(p1, { ctype: "spell-attack-roll", outcome: "success", statistic: "spell-attack", actor: KYRA, item: { name: "Divine Lance", type: "spell" }, target: { actor: true, token: true }, roll: { total: 21 } }, `m${round}a`);
    });
    await turn(round, 1, GOB, false, round === 2 ? 22 : 25, async (t) => {
      w.at(t + 8); check(gm, { ctype: "attack-roll", outcome: "failure", statistic: "attack", actor: GOB, item: { name: "Dogslicer", type: "melee" }, target: { actor: true, token: true }, roll: { total: 12 } }, `m${round}b`);
      if (variant === "A" && round === 2) {
        w.at(t + 12);
        p2.e("perf.loaf", { ms: 2350, blocking: 2290, scripts: [{ origin: "fxmaster", invoker: "FrameRequestCallback", ms: 1900 }] });
        const st = p2.e("perf.stall", { ms: 2400, attribution: [{ origin: "fxmaster", ms: 1900, invoker: "FrameRequestCallback" }], hooks: { lightingRefresh: 4, sightRefresh: 6 } }, { sev: "warn" });
        truth.stallId = st.id;
      }
    });
    await turn(round, 2, EZREN, true, variant === "A" ? (round === 1 ? 250 : 110) : 75, async (t) => {
      if (variant === "A" && round === 1) {
        const sh = p2.openApp("CharacterSheetPF2e", EZREN);
        for (let i = 0; i < 3; i++) { w.at(t + 5 + i * 6); p2.e("ui.tab", { tab: "spellcasting", group: "primary", cls: "CharacterSheetPF2e" }); }
        w.at(t + 25); p2.e("ui.action", { action: "toggle-summary", cls: "CharacterSheetPF2e", item: ARC, readsRules: true, spellGroup: "cantrips" });
        w.at(t + 33); p2.e("ui.action", { action: "toggle-summary", cls: "CharacterSheetPF2e", item: ARC, readsRules: true, spellGroup: "cantrips" });
        w.at(t + 40); const dlg = p2.openApp("CheckModifiersDialog", null);
        w.at(t + 48); p2.close(dlg);
        truth.abandonedDialog = dlg.id;
        for (let i = 0; i < 3; i++) { w.at(t + 55 + i * 5); p2.e("ui.notify", { kind: "warning", msg: "You must target exactly one token." }, { sev: "warn" }); }
        for (let i = 0; i < 6; i++) { w.at(t + 70 + i * 2); p2.e("token.target", { token: { uuid: "Scene.scCrypt.Token.gob2" }, actor: GOB, targeted: i % 2 === 0, nTargets: i % 2 === 0 ? 1 : 0 }); }
        w.at(t + 90); check(p2, { ctype: "spell-attack-roll", outcome: "failure", statistic: "spell-attack", actor: EZREN, item: ARC, target: null, roll: { total: 9 } }, "m1c_notarget");
        w.at(t + 120); const fr = p2.e("friction.mark", { cat: "rules", note: "how do I target two enemies with Electric Arc? mail me ezren@example.org", recent: ["token.target", "pf2e.check"], openApps: ["CharacterSheetPF2e"] }, { sev: "notice" });
        truth.frictionId = fr.id;
        w.at(t + 200); check(p2, { ctype: "spell-attack-roll", outcome: "success", statistic: "spell-attack", actor: EZREN, item: ARC, target: { actor: true, token: true }, roll: { total: 19 } }, "m1c");
        w.at(t + 220); p2.e("pf2e.reroll", { resource: "hero-points", keep: "new", old: 9, new: 19 });
        w.at(t + 240); p2.close(sh);
      } else {
        w.at(t + 20); p2.e("token.target", { token: { uuid: "Scene.scCrypt.Token.gob2" }, actor: GOB, targeted: true, nTargets: 1 });
        w.at(t + 40); check(p2, { ctype: "spell-attack-roll", outcome: "success", statistic: "spell-attack", actor: EZREN, item: ARC, target: { actor: true, token: true }, roll: { total: 20 } }, `m${round}c`);
      }
    });
    await turn(round, 3, VALEROS, true, variant === "A" && round === 2 ? 180 : 40, async (t) => {
      if (variant === "A" && round === 2) {
        // p3 loses its Foundry socket, crashes with unsent events, reloads as a new client instance
        w.at(t + 5); p3.e("net.socket", { state: "disconnect", reason: "transport close" }, { sev: "warn" });
        await p3.rec.flush();
        w.at(t + 8); p3.e("ui.action", { action: "strike", cls: "CharacterSheetPF2e" }); // never sent: crash
        p3.alive = false;
        truth.p3OldClient = p3.rec.clientId;
        w.at(t + 95);
        const p3b = new Client(w, { name: "p3", user: "u_valeros", role: "player", skew: -4000 });
        p3b.ctx = { ...p3.ctx };
        p3b.join(id, { env, sceneMs: 9000 });
        truth.p3NewClient = p3b.rec.clientId;
        w.at(t + 150); check(p3b, { ctype: "attack-roll", outcome: "critical-success", statistic: "attack", actor: VALEROS, item: { name: "Longsword", type: "weapon" }, target: { actor: true, token: true }, roll: { total: 27 } }, `m${round}d`);
      } else {
        const c = w.clients.filter((x) => x.user === "u_valeros" && x.alive).at(-1);
        const SWORD = { uuid: "Actor.valeros.Item.sword", doc: "Item", type: "weapon", name: "Longsword", slug: "longsword" };
        w.at(t + 10); c.e("ui.action", { action: "strike-attack", cls: "CharacterSheetPF2e", item: SWORD, strike: "longsword", variant: 0 });
        w.at(t + 25); c.e("ui.action", { action: "strike-attack", cls: "CharacterSheetPF2e", item: SWORD, strike: "longsword", variant: 1 });
        w.at(t + 15); check(c, { ctype: "attack-roll", outcome: "success", statistic: "attack", actor: VALEROS, item: { name: "Longsword", type: "weapon" }, target: { actor: true, token: true }, roll: { total: 22 } }, `m${round}d`);
      }
    });
  }
  w.at(tt + 5);
  gm.e("combat.end", { combat: "cbt1", rounds: 3, started: true }, { dk: "combat:cbt1:end" });
  for (const c of w.clients) c.ctx.combat = undefined;
  await w.flush();

  // --- storage outage for p1 (variant A): its queue (maxQueue 40) overflows and reports the loss
  if (variant === "A") {
    p1.down = true;
    for (let i = 0; i < 70; i++) { w.at(tt + 60 + i * 3); p1.e("ui.tab", { tab: i % 2 ? "actions" : "spellcasting", group: "primary", cls: "CharacterSheetPF2e" }); await p1.rec.flush(); }
    w.at(tt + 300); p1.down = false; p1.rec.backoff = 0;
    await p1.rec.flush(); await p1.rec.flush();
  }
  w.at(3480);
  gm.e("session.stop", { by: "gm" });
  for (const c of w.clients) if (c.alive) { c.e("client.unload", {}); }
  await w.flush();
  return truth;
}

export async function generate(store, { t0 = Date.UTC(2026, 9, 3, 18, 0, 0) } = {}) {
  const a = await session(store, { id: "20261003-2000-synA", t0, variant: "A" });
  const b = await session(store, { id: "20261010-2000-synB", t0: t0 + 7 * DAY, variant: "B" });
  return { a, b };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf("--db");
  const file = i > 0 ? process.argv[i + 1] : "./data/fixture.db";
  const db = openDb(file);
  const truth = await generate(new Store(db));
  console.log(JSON.stringify({ db: file, truth }, null, 1));
}
