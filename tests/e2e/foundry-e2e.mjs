#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// REAL runtime validation against a licensed local Foundry V14 + PF2e instance (not part of `npm test`).
// Drives a GM and a Player browser with Playwright, records a session into an in-process collector,
// verifies the evidence with the analysis library, measures overhead, then restores the world.
//
// Env: FOUNDRY_URL (default http://127.0.0.1:30000), FFR_PLAYWRIGHT (dir containing node_modules/playwright-core),
//      FFR_GM_USER (default "Gamemaster"), FFR_PLAYER_USER (default "Joueur"), FFR_GM_PASSWORD.
// Run under the lab lock when sharing the instance: flock /tmp/maxi.lock node tests/e2e/foundry-e2e.mjs
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createCollector } from "../../packages/collector/server.mjs";
import * as A from "../../packages/analysis-cli/analyze.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const URL_ = process.env.FOUNDRY_URL ?? "http://127.0.0.1:30000";
const PW_DIR = process.env.FFR_PLAYWRIGHT ?? path.join(process.env.HOME, "dev/personal/foundry-maxi-lab");
const { chromium } = createRequire(path.join(PW_DIR, "package.json"))("playwright-core");
const MOD = "foundry-flight-recorder";
const KEY = "e2e-ingest-key";
const PORT = 4319;
const out = path.join(root, "tests/.tmp");
fs.mkdirSync(out, { recursive: true });
const dbFile = path.join(out, "e2e.db");
for (const f of [dbFile, dbFile + "-wal", dbFile + "-shm"]) fs.rmSync(f, { force: true });

const log = (...a) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...a);
const results = { url: URL_, startedAt: new Date().toISOString(), checks: [], overhead: {}, notes: [] };
const check = (name, ok, detail = null) => { results.checks.push({ name, ok: !!ok, detail }); log(ok ? "PASS" : "FAIL", name, detail ? JSON.stringify(detail).slice(0, 200) : ""); };

const col = createCollector({ host: "127.0.0.1", port: PORT, db: dbFile, ingestKey: KEY, origins: [new URL(URL_).origin], maxDbMb: 500, retentionDays: 0, sessionIdleMin: 600, rateRps: 50, rateEventsPerMin: 20000 });
await new Promise((r) => col.server.listen(PORT, "127.0.0.1", r));
log("collector on", PORT);

const exe = fs.readdirSync(path.join(process.env.HOME, ".cache/ms-playwright")).filter((d) => d.startsWith("chromium-")).sort().pop();
const browser = await chromium.launch({ executablePath: path.join(process.env.HOME, ".cache/ms-playwright", exe, "chrome-linux64/chrome"), headless: true, args: ["--enable-features=LongAnimationFrameTiming"] });

async function join(userName, password = "") {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  page.on("pageerror", () => {});
  await page.goto(`${URL_}/join`);
  await page.getByRole("combobox").first().selectOption({ label: userName });
  if (password) await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button").filter({ hasText: /Rejoindre|Join Game Session/i }).click();
  await page.waitForFunction(() => window.game?.ready, null, { timeout: 240000 });
  await page.waitForTimeout(2000);
  return page;
}
// Foundry may reload clients by itself (e.g. after moduleConfiguration changes): retry once when the context dies.
async function ev(page, fn, arg) {
  for (let i = 0; ; i++) {
    try {
      await page.waitForFunction(() => window.game?.ready, null, { timeout: 240000 });
      return await page.evaluate(fn, arg);
    } catch (e) {
      if (i < 2 && /not defined|context was destroyed|navigation/i.test(e.message)) { await page.waitForTimeout(5000); continue; }
      throw e;
    }
  }
}
const reloadReady = async (page) => { await page.reload({ waitUntil: "load" }); await page.waitForFunction(() => window.game?.ready, null, { timeout: 240000 }); await page.waitForTimeout(2000); };
const settle = async (page) => { await page.waitForTimeout(6000); await page.waitForFunction(() => window.game?.ready, null, { timeout: 240000 }); };

const GM_USER = process.env.FFR_GM_USER ?? "Gamemaster";
const PLAYER = process.env.FFR_PLAYER_USER ?? "Joueur";
const gm = await join(GM_USER, process.env.FFR_GM_PASSWORD ?? "");
log("GM joined");

// --- enable module (remember original world state for restoration)
const original = await ev(gm, async ({ MOD, PLAYER }) => {
  if (!game.users.getName(PLAYER)) await User.create({ name: PLAYER, role: CONST.USER_ROLES.PLAYER });
  return { modCfg: game.settings.get("core", "moduleConfiguration")[MOD] ?? false, scene: game.scenes.active?.id ?? null, active: !!game.modules.get(MOD)?.active };
}, { MOD, PLAYER });
results.notes.push(`module initially active: ${original.active}`);

// test scene with a PC (owned by the player) and an NPC
const fixture = await ev(gm, async (PLAYER) => {
  const pu = game.users.getName(PLAYER);
  const pc = game.actors.find((a) => a.type === "character");
  const npc = game.actors.find((a) => a.type === "npc");
  if (!pc || !npc) return { error: "world needs at least one character and one npc actor" };
  await pc.update({ [`ownership.${pu.id}`]: 3 });
  const scene = await Scene.create({ name: "FFR e2e", width: 2000, height: 1500, padding: 0, grid: { type: 1, size: 100, distance: 5, units: "ft" }, tokenVision: false, "flags.world.ffrE2e": true });
  for (const [a, x] of [[pc, 300], [npc, 700]]) await scene.createEmbeddedDocuments("Token", [(await a.getTokenDocument({ x, y: 300 })).toObject()]);
  await scene.activate();
  return { scene: scene.id, pc: pc.id, npc: npc.id, pcName: pc.name };
}, PLAYER);
if (fixture.error) throw new Error(fixture.error);
await gm.waitForFunction((id) => canvas.ready && canvas.scene?.id === id, fixture.scene, { timeout: 60000 });

// baseline workload BEFORE enabling (module inactive) for overhead comparison
const WORKLOAD = async () => {
  const actor = game.actors.find((a) => a.type === "character") ?? game.actors.contents[0];
  const t0 = performance.now();
  for (let i = 0; i < 8; i++) { await actor.sheet.render({ force: true }); await new Promise((r) => setTimeout(r, 150)); await actor.sheet.close(); await new Promise((r) => setTimeout(r, 50)); }
  const sheetMs = performance.now() - t0;
  const tok = canvas.tokens?.placeables?.[0];
  const t1 = performance.now();
  if (tok) for (let i = 0; i < 100; i++) tok.setTarget(i % 2 === 0, { releaseOthers: false });
  const targetMs = performance.now() - t1;
  // frame pacing for 5 s
  const frames = await new Promise((resolve) => { const ts = []; let last = 0; const end = performance.now() + 5000; const f = (t) => { if (last) ts.push(t - last); last = t; if (t < end) requestAnimationFrame(f); else resolve(ts); }; requestAnimationFrame(f); });
  frames.sort((a, b) => a - b);
  const t2 = performance.now();
  for (let i = 0; i < 300; i++) Hooks.callAll("ffrE2eNoop", i);
  return { sheetMs: Math.round(sheetMs), targetMs: Math.round(targetMs * 10) / 10, framesP50: Math.round(frames[Math.floor(frames.length / 2)] * 10) / 10, framesP95: Math.round(frames[Math.floor(frames.length * 0.95)] * 10) / 10, nFrames: frames.length, heapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null, tokenPresent: !!tok, actor: actor?.type };
};
if (!original.active) {
  results.overhead.baselineGm = await ev(gm, WORKLOAD);
  log("baseline (module inactive)", results.overhead.baselineGm);
  await ev(gm, async (MOD) => { const c = game.settings.get("core", "moduleConfiguration"); c[MOD] = true; await game.settings.set("core", "moduleConfiguration", c); }, MOD);
  await settle(gm);
  await reloadReady(gm);
}
check("module active after enabling", await ev(gm, (MOD) => !!game.modules.get(MOD)?.active, MOD));

// --- configure (world) + consent (client)
await ev(gm, async ({ MOD, KEY, PORT }) => {
  await game.settings.set(MOD, "endpoint", `http://127.0.0.1:${PORT}/v1/ingest`);
  await game.settings.set(MOD, "ingestKey", KEY);
  await game.settings.set(MOD, "mode", "normal");
  await game.settings.set(MOD, "participation", "yes");
  await game.settings.set(MOD, "enabled", true);
}, { MOD, KEY, PORT });

let player = await join(PLAYER);
await ev(player, async (MOD) => { await game.settings.set(MOD, "participation", "yes"); }, MOD);
log("player joined");

// --- start session (GM)
await ev(gm, async (MOD) => { await game.modules.get(MOD).api.start("E2E real Foundry run"); }, MOD);
await gm.waitForTimeout(2000);
const st = await Promise.all([gm, player].map((p) => ev(p, (MOD) => game.modules.get(MOD).api.status(), MOD)));
check("both clients recording", st.every((s) => s.state === "active"), st.map((s) => ({ state: s.state, session: s.sessionId })));
const sessionId = st[0].sessionId;

// --- player interactions
const pAct = await ev(player, async ({ pcId, npcName }) => {
  const r = {};
  const actor = game.actors.get(pcId);
  await actor.sheet.render({ force: true });
  await new Promise((res) => setTimeout(res, 1500));
  const el = actor.sheet.element instanceof HTMLElement ? actor.sheet.element : actor.sheet.element?.[0];
  const tabs = [...(el?.querySelectorAll("nav [data-tab]") ?? [])];
  r.tabs = tabs.map((t) => t.dataset.tab).slice(0, 10);
  for (const t of tabs.slice(1, 4)) { t.click(); await new Promise((res) => setTimeout(res, 300)); }
  const actionBtn = el?.querySelector("[data-action]");
  r.actionClicked = actionBtn?.dataset.action ?? null;
  // no click on actions: some open dialogs; we only need one harmless action -> use the first tab again
  if (tabs[0]) tabs[0].click();
  // targeting (toggle 4x)
  const npcTok = canvas.tokens.placeables.find((t) => t.actor?.type === "npc");
  for (let i = 0; i < 4; i++) { npcTok?.setTarget(i % 2 === 0, { releaseOthers: true }); await new Promise((res) => setTimeout(res, 200)); }
  npcTok?.setTarget(true, { releaseOthers: true });
  // a PF2e check (perception, no dialog)
  try { await actor.perception.roll({ skipDialog: true }); r.check = "perception"; } catch (e) { r.checkError = String(e.message).slice(0, 120); }
  await actor.sheet.close();
  ui.notifications.warn("FFR e2e: synthetic warning");
  return r;
}, { pcId: fixture.pc, npcName: null });
log("player actions", pAct);

// --- GM combat
await ev(gm, async (sceneId) => {
  const scene = game.scenes.get(sceneId);
  const combat = await Combat.create({ scene: scene.id, active: true });
  await combat.createEmbeddedDocuments("Combatant", scene.tokens.map((t) => ({ tokenId: t.id, sceneId: scene.id, actorId: t.actorId, initiative: t.actor.type === "character" ? 20 : 10 })));
  await combat.startCombat();
  await new Promise((r) => setTimeout(r, 2500));
  await combat.nextTurn();
  await new Promise((r) => setTimeout(r, 1500));
  await combat.nextTurn();
  await new Promise((r) => setTimeout(r, 1000));
  await combat.delete();
}, fixture.scene);

// --- injected error, stall, friction on the player
await ev(player, () => { setTimeout(() => { throw new Error("FFR e2e injected error"); }, 0); });
await player.waitForTimeout(500);
await ev(player, () => new Promise((res) => requestAnimationFrame(() => { const t = performance.now(); while (performance.now() - t < 1600) { /* busy: simulated freeze */ } requestAnimationFrame(() => requestAnimationFrame(res)); })));
await ev(player, (MOD) => game.modules.get(MOD).api.mark("confusing", "e2e friction marker"), MOD);
await player.waitForTimeout(12000); // let a perf.window elapse
const before = await ev(player, (MOD) => game.modules.get(MOD).api.status(), MOD);

// --- player reload (reconnect as a new client instance)
await reloadReady(player);
await player.waitForTimeout(3000);
const after = await ev(player, (MOD) => game.modules.get(MOD).api.status(), MOD);
check("player resumes recording after reload with new client id", after.state === "active" && after.clientId !== before.clientId, { before: before.clientId, after: after.clientId });

// overhead workload with module recording (GM page), for comparison
results.overhead.recordingGm = await ev(gm, WORKLOAD);
log("workload (recording)", results.overhead.recordingGm);
results.overhead.emitMicrobench = await ev(gm, (MOD) => {
  const rec = game.modules.get(MOD).api.recorder;
  const t = performance.now();
  for (let i = 0; i < 2000; i++) rec.emit("ui.click", { tag: "button", cls: "Bench", i }, { lvl: 9 }); // lvl 9: ring only, never sent
  return { emits: 2000, usPerEmit: Math.round(((performance.now() - t) / 2000) * 1000 * 10) / 10 };
}, MOD);

// --- stop
results.gmStatusBeforeStop = await ev(gm, (MOD) => game.modules.get(MOD).api.status(), MOD);
log("GM status before stop", results.gmStatusBeforeStop);
await ev(gm, async (MOD) => { await game.modules.get(MOD).api.stop(); }, MOD);
await gm.waitForTimeout(4000);
await ev(player, (MOD) => game.modules.get(MOD).api.recorder.flush(), MOD);
await player.waitForTimeout(2000);

// ---------------------------------------------------------------------------
// verify with the analysis library
const db = col.db;
const types = Object.fromEntries(db.prepare("SELECT type, COUNT(*) n FROM events WHERE session_id = ? GROUP BY type").all(sessionId).map((r) => [r.type, r.n]));
results.eventsByType = types;
const inf = A.info(db, sessionId);
check("session recorded and ended by GM stop", inf.session.status === "ended" && inf.session.label === "E2E real Foundry run", inf.session);
check("3 client instances (GM, player, player after reload)", inf.clients.length === 3, inf.clients.map((c) => [c.role, c.events]));
check("env snapshot with real module list", inf.clients.every((c) => c.env?.foundry?.startsWith("14")), inf.clients.map((c) => c.env?.foundry));
const mods = Object.assign({}, ...A.events(db, sessionId, { types: ["env.modules"], limit: 1000 }).filter((e) => e.user === inf.clients[0].user).map((e) => e.data.modules));
check("modules snapshot includes pf2e-relevant modules and self", Object.keys(mods).length > 20 && mods[MOD] === "0.1.0", { n: Object.keys(mods).length });
check("env.settings snapshot present and free of credentials", (types["env.settings"] ?? 0) > 0 && !JSON.stringify(A.events(db, sessionId, { types: ["env.settings"], limit: 1000 }).map((e) => e.data)).includes(KEY));
for (const t of ["scene.load", "scene.summary", "ui.app.open", "ui.app.close", "ui.tab", "token.target", "combat.start", "combat.turn", "combat.end", "chat.message", "pf2e.check", "err.js", "ui.notify", "friction.mark", "perf.window", "perf.stall", "rec.adapter", "client.unload"]) check(`captured ${t}`, (types[t] ?? 0) > 0, types[t] ?? 0);
const opens = A.events(db, sessionId, { types: ["ui.app.open"], limit: 500 });
check("PF2e character sheet (AppV1) open/close captured", opens.some((e) => e.data?.cls === "CharacterSheetPF2e") && A.events(db, sessionId, { types: ["ui.app.close"], limit: 500 }).some((e) => e.data?.cls === "CharacterSheetPF2e"), opens.map((e) => e.data?.cls));
check("frameless UI (Sidebar, Players, HUD) not reported as opened windows", !opens.some((e) => ["Sidebar", "Players", "Hotbar", "SceneControls"].includes(e.data?.cls)));
check("no sequence gaps on any client", inf.clients.every((c) => c.seqMissing === 0), inf.clients.map((c) => [c.client, c.seqMissing]));
const errs = A.errors(db, sessionId, { grep: "FFR e2e injected" });
check("injected error grouped", errs.length === 1 && errs[0].count >= 1, errs[0]?.ids);
if (errs[0]) {
  const w = A.around(db, sessionId, { event: errs[0].ids[0], before: 30000, after: 5000 });
  check("evidence window before injected error contains player's interactions", w.events.some((e) => e.type === "token.target" || e.type === "chat.message" || e.type === "pf2e.check"), w.events.length);
}
const tr = A.turns(db, sessionId);
check("combat turns reconstructed with durations", tr.turns.filter((t) => t.durS !== null).length >= 2, tr.turns.map((t) => [t.actor, t.durS, t.outcome]));
const stall = A.perf(db, sessionId).stalls;
check("freeze detected (>=1000 ms frame)", stall.some((s) => s.ms >= 1000), stall.map((s) => s.ms));
const chk = A.events(db, sessionId, { types: ["pf2e.check"], limit: 50 });
check("pf2e.check carries context type and actor", chk.some((c) => c.data?.ctype && c.data?.actor), chk.map((c) => [c.data?.ctype, c.data?.outcome]));
const allData = db.prepare("SELECT data FROM events WHERE session_id = ?").all(sessionId).map((r) => r.data ?? "").join("\n");
check("no chat content / html / ingest key leaked into storage", !/"content"\s*:|<p>|e2e-ingest-key/.test(allData));
const fr = A.friction(db, sessionId);
check("friction marker stored with context", fr.length === 1 && fr[0].note === "e2e friction marker", fr[0] && { cat: fr[0].category, preceding: fr[0].precedingTypes });
results.health = col.stats;
results.anomalies = A.anomalies(db, sessionId).map((a) => `${a.severity} ${a.kind}: ${a.summary}`).slice(0, 25);

// ---------------------------------------------------------------------------
// restore world: disable recorder, restore module enablement (measure baseline again), delete test scene
await ev(gm, async (MOD) => { await game.settings.set(MOD, "enabled", false); }, MOD);
if (!original.active) {
  await ev(gm, async (MOD) => { const c = game.settings.get("core", "moduleConfiguration"); delete c[MOD]; await game.settings.set("core", "moduleConfiguration", c); }, MOD);
  await settle(gm);
  await reloadReady(gm);
  results.overhead.afterDisableGm = await ev(gm, WORKLOAD);
  log("workload (module inactive again)", results.overhead.afterDisableGm);
  check("world restored: module inactive", !(await ev(gm, (MOD) => !!game.modules.get(MOD)?.active, MOD)));
}
await ev(gm, async (original) => {
  for (const s of game.scenes.filter((s) => s.getFlag("world", "ffrE2e"))) await s.delete();
  if (original.scene) await game.scenes.get(original.scene)?.activate();
}, original);
await browser.close();
await new Promise((r) => col.server.close(r));
results.sessionId = sessionId;
results.passed = results.checks.filter((c) => c.ok).length;
results.failed = results.checks.filter((c) => !c.ok).length;
fs.writeFileSync(path.join(out, "e2e-results.json"), JSON.stringify(results, null, 1));
log(`done: ${results.passed} passed, ${results.failed} failed -> tests/.tmp/e2e-results.json`);
process.exit(results.failed ? 1 : 0);
