// Integration helpers for Playwright test runners (e.g. foundry-maxi-lab runner/run.mjs, flag MAXI_FFR=1).
// Records one flight-recorder session per test, so `ffr errors|perf|anomalies <session>` and
// `ffr compare <a> <b>` work per test. Prerequisite: the module is installed AND enabled in the world
// (node scripts/build-module.mjs --install <Data>/modules, then enable it); this file never toggles
// the module set, so perf trials stay untouched when MAXI_FFR is unset.
//
// The module writes its batches as files on the Foundry server (<Foundry Data>/flight-recorder); after the
// run, importRecordings() loads them into a database for `ffr`.
//
//   import * as ffr from "<repo>/tools/maxi-runner.mjs";
//   await ffr.configure(page);  await ffr.configure(playerPage, { player: true });
//   const s = await ffr.start(page, `test ${id}`);  ...run test...  await ffr.stop(page, [playerPage]);
//   ffr.importRecordings({ dataDir: "<host path of Foundry's Data>", db: "report/ffr.db" });
import path from "node:path";
import { openDb, importStorage } from "../packages/analysis-cli/db.mjs";
import { STORAGE_ROOT } from "../packages/foundry-module/scripts/store.mjs";

const MOD = "foundry-flight-recorder";

/**
 * Opt a client in. World settings are written by the GM page only; participation is per user account
 * (user setting, set from that user's own client). Throws if the module is not active in the world.
 * Keep mode "normal" for perf trials: "diagnostic" times every hook listener.
 */
export async function configure(page, { player = false, mode = "normal" } = {}) {
  return page.evaluate(async ({ MOD, player, mode }) => {
    if (!game.modules.get(MOD)?.active) throw new Error(`${MOD} is not active in this world`);
    if (!player) await game.settings.set(MOD, "mode", mode);
    await game.settings.set(MOD, "participation", "yes");
    return true;
  }, { MOD, player, mode });
}

/** Load the recordings written on the Foundry server into `db` (created if missing). Idempotent. */
export function importRecordings({ dataDir, db = "./data/ffr.db" }) {
  const d = openDb(db);
  try { return importStorage(d, [path.join(dataDir, STORAGE_ROOT)]); } finally { d.close(); }
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
