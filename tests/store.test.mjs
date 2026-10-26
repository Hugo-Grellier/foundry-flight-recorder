// Collector-less storage (packages/foundry-module/scripts/store.mjs): direct writes, GM relay, then
// `ffr import` of the written files. Foundry's upload endpoint is emulated with its real V14 rules
// (target directory must exist, non-media files are never overwritten).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { FoundryStore, FOUNDRY_ENDPOINT, STORAGE_ROOT } from "../packages/foundry-module/scripts/store.mjs";
import { Recorder } from "../packages/foundry-module/scripts/recorder.mjs";

function fakeServer() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ffr-data-"));
  fs.mkdirSync(path.join(root, "modules/foundry-flight-recorder"), { recursive: true });
  return {
    root,
    mkdir: async (p) => fs.mkdirSync(path.join(root, p)), // throws EEXIST like the server refuses an existing dir
    upload: async (dir, name, text) => {
      const d = path.join(root, dir);
      if (!fs.existsSync(d)) return { error: `Target directory ${d} does not exist.` };
      if (fs.existsSync(path.join(d, name))) return { error: "You may not upload non-media files which would overwrite an existing file on the server." };
      fs.writeFileSync(path.join(d, name), text);
      return { path: `${dir}/${name}` };
    },
  };
}

// Two clients on one fake socket: a player (no upload permission) and the GM.
function table({ playerCanUpload = false, gmOnline = true, timeoutMs = 1000 } = {}) {
  const srv = fakeServer();
  const clients = {};
  const emitFrom = (from) => (msg, recipients) => { for (const r of recipients) queueMicrotask(() => clients[r]?.handle(msg, from)); };
  const mk = (id, canUpload, isGM) => (clients[id] = new FoundryStore({
    upload: srv.upload, mkdir: srv.mkdir, emit: emitFrom(id), canUpload: () => canUpload, timeoutMs,
    relayTo: () => (gmOnline ? "gm" : null), isRelay: () => isGM, pseudo: (u) => `u_${u}`,
  }));
  return { srv, player: mk("pl", playerCanUpload, false), gm: mk("gm", true, true) };
}

const env = (seq, over = {}) => ({ v: 1, sessionId: "s1", clientId: "cabc", user: "u_pl", world: "w", sentAt: 1, batchSeq: seq, dropped: 0, events: [{ id: `cabc.${seq}`, seq, type: "ui.tab", t: 1, mono: 1, data: {} }], ...over });
const send = (s, e) => s.send(FOUNDRY_ENDPOINT, { body: JSON.stringify(e) });
const files = (srv) => fs.readdirSync(path.join(srv.root, STORAGE_ROOT, "w", "s1")).sort();

test("a client allowed to upload writes its own batches: one file per batch, directories created once", async () => {
  const { srv, player } = table({ playerCanUpload: true, gmOnline: false });
  assert.deepEqual(await send(player, env(0)), { ok: true, status: 200 });
  assert.deepEqual(await send(player, env(1)), { ok: true, status: 200 });
  assert.deepEqual(files(srv), ["cabc-00000000.json", "cabc-00000001.json"]);
  // a retry of a batch whose first attempt was stored (timeout after success) is not an error
  assert.deepEqual(await send(player, env(1)), { ok: true, status: 200 });
  // next session of the same world: storage/ and storage/w already exist
  assert.deepEqual(await send(player, env(0, { sessionId: "s2" })), { ok: true, status: 200 });
});

test("a player without upload permission relays to the GM, who stamps the sender's pseudonym", async () => {
  const { srv, player } = table();
  assert.deepEqual(await send(player, env(0, { user: "u_someone_else" })), { ok: true, status: 200 });
  const stored = JSON.parse(fs.readFileSync(path.join(srv.root, STORAGE_ROOT, "w", "s1", "cabc-00000000.json"), "utf8"));
  assert.equal(stored.user, "u_pl");
});

test("no GM online or no answer: retryable failure, nothing written", async () => {
  assert.deepEqual(await send(table({ gmOnline: false }).player, env(0)), { ok: false, status: 0 });
  const t = table({ timeoutMs: 20 });
  t.gm.o.isRelay = () => false; // GM client not relaying (recorder disabled there)
  assert.deepEqual(await send(t.player, env(0)), { ok: false, status: 0 });
  assert.equal(fs.existsSync(path.join(t.srv.root, STORAGE_ROOT, "w")), false);
});

test("Recorder over the Foundry store, then `ffr import`: events land in the database, re-import is idempotent", async () => {
  const { srv, player } = table();
  const rec = new Recorder({ fetch: (u, i) => player.send(u, i), setTimer: () => null, clearTimer: () => {} });
  rec.configure({ endpoint: FOUNDRY_ENDPOINT, sessionId: "s1", user: "u_pl", role: "player", world: "w" });
  rec.activate();
  rec.emit("session.start", { label: "x" });
  rec.emit("ui.tab", { tab: "actors" });
  await rec.flush();
  assert.equal(rec.status().sent, 2);
  const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ffr-imp-")), "x.db");
  const ffr = (...a) => JSON.parse(execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", "packages/analysis-cli/ffr.mjs", ...a, "--db", db, "--json"], { encoding: "utf8" }));
  const dir = path.join(srv.root, STORAGE_ROOT);
  assert.deepEqual(ffr("import", dir), { files: 1, accepted: 2, duplicates: 0, rejectedEvents: 0, invalidFiles: [] });
  assert.equal(ffr("import", dir).duplicates, 2);
  assert.deepEqual(ffr("sessions").map((s) => s.id), ["s1"]);
});
