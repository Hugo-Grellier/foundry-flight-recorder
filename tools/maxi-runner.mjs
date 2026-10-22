// Integration helpers for Playwright test runners (e.g. foundry-maxi-lab runner/run.mjs, flag MAXI_FFR=1).
// Records one flight-recorder session per test, so `ffr errors|perf|anomalies <session>` and
// `ffr compare <a> <b>` work per test. Prerequisite: the module is installed AND enabled in the world
// (node scripts/build-module.mjs --install <Data>/modules, then enable it); this file never toggles
// the module set, so perf trials stay untouched when MAXI_FFR is unset.
//
//   import * as ffr from "<repo>/tools/maxi-runner.mjs";
//   const rec = await ffr.startCollector({ db: "report/ffr.db" });   // in-process collector
//   await ffr.configure(page, rec);  await ffr.configure(playerPage, rec, { player: true });
//   const s = await ffr.start(page, `test ${id}`);  ...run test...  await ffr.stop(page, [playerPage]);
import { createCollector } from "../packages/collector/server.mjs";

const MOD = "foundry-flight-recorder";

/** Start an in-process collector. Returns { endpoint, key, db, close() }. */
export async function startCollector({ db = "./data/ffr.db", port = 4319, origin = "http://127.0.0.1:30000", key = `runner-${Date.now()}` } = {}) {
  const col = createCollector({ host: "127.0.0.1", port, db, ingestKey: key, origins: [origin], maxDbMb: 4096, retentionDays: 0, sessionIdleMin: 600, rateRps: 100, rateEventsPerMin: 60000 });
  await new Promise((r) => col.server.listen(port, "127.0.0.1", r));
  return { endpoint: `http://127.0.0.1:${port}/v1/ingest`, key, db, stats: col.stats, close: () => new Promise((r) => col.server.close(r)) };
}

/**
 * Point a client at the collector and opt it in. World settings are written by the GM page only;
 * participation is per browser (client setting). Throws if the module is not active in the world.
 */
export async function configure(page, { endpoint, key }, { player = false, mode = "normal" } = {}) {
  return page.evaluate(async ({ MOD, endpoint, key, player, mode }) => {
    if (!game.modules.get(MOD)?.active) throw new Error(`${MOD} is not active in this world`);
    if (!player) {
      await game.settings.set(MOD, "endpoint", endpoint);
      await game.settings.set(MOD, "ingestKey", key);
      await game.settings.set(MOD, "mode", mode);
    }
    await game.settings.set(MOD, "participation", "yes");
    return true;
  }, { MOD, endpoint, key, player, mode });
}

/** GM page: start a session labelled `label`. Returns the session id. */
export async function start(page, label) {
  return page.evaluate(async ({ MOD, label }) => {
    const api = game.modules.get(MOD).api;
    await api.start(label);
    for (let i = 0; i < 50 && api.status().state !== "active"; i++) await new Promise((r) => setTimeout(r, 100));
    return api.status().sessionId;
  }, { MOD, label });
}

/** GM page: stop the session, after flushing the given other pages (players). */
export async function stop(page, others = []) {
  for (const p of others) await p.evaluate((MOD) => game.modules.get(MOD)?.api?.recorder.flush(), MOD).catch(() => {});
  return page.evaluate(async (MOD) => {
    const api = game.modules.get(MOD).api;
    const before = api.status();
    await api.stop();
    return { session: before.sessionId, sent: before.sent, dropped: before.dropped };
  }, MOD);
}
