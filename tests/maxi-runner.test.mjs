// tools/maxi-runner.mjs against a fake Playwright page (evaluate runs in this process with a fake `game`).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as ffr from "../tools/maxi-runner.mjs";

function fakeGame({ active = true } = {}) {
  const settings = {};
  let session = null, state = "off";
  const api = {
    start: async (label) => { session = `s-${label}`; state = "active"; },
    stop: async () => { state = "off"; },
    status: () => ({ state, sessionId: session, sent: 3, dropped: 0 }),
    recorder: { flush: async () => { api.flushed = (api.flushed ?? 0) + 1; } },
  };
  return { settings, api, game: { modules: { get: () => ({ active, api }) }, settings: { set: async (m, k, v) => { settings[`${m}.${k}`] = v; } } } };
}
const pageFor = (g) => ({ evaluate: async (fn, arg) => { globalThis.game = g.game; try { return await fn(arg); } finally { delete globalThis.game; } } });

test("collector starts and answers health", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ffr-mr-"));
  const c = await ffr.startCollector({ db: path.join(dir, "r.db"), port: 0 + 4391 });
  const h = await (await fetch(c.endpoint.replace("/v1/ingest", "/healthz"))).json();
  assert.equal(h.ok, true);
  await c.close();
});

test("configure writes world settings on GM, only participation on players; refuses inactive module", async () => {
  const gm = fakeGame(), pl = fakeGame();
  await ffr.configure(pageFor(gm), { endpoint: "http://x/v1/ingest", key: "k" });
  assert.equal(gm.settings["foundry-flight-recorder.endpoint"], "http://x/v1/ingest");
  assert.equal(gm.settings["foundry-flight-recorder.participation"], "yes");
  await ffr.configure(pageFor(pl), { endpoint: "e", key: "k" }, { player: true });
  assert.deepEqual(Object.keys(pl.settings), ["foundry-flight-recorder.participation"]);
  await assert.rejects(ffr.configure(pageFor(fakeGame({ active: false })), { endpoint: "e", key: "k" }), /not active/);
});

test("start returns the session id; stop flushes players first", async () => {
  const gm = fakeGame(), pl = fakeGame();
  assert.equal(await ffr.start(pageFor(gm), "T 23-combat-flow"), "s-T 23-combat-flow");
  const r = await ffr.stop(pageFor(gm), [pageFor(pl)]);
  assert.equal(r.session, "s-T 23-combat-flow");
  assert.equal(pl.api.flushed, 1);
});
