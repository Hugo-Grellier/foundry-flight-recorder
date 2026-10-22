import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createCollector } from "../packages/collector/server.mjs";
import { openDb, finalizeIdle, applyRetention, deleteSession, deleteUser } from "../packages/collector/db.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ffr-col-"));
let col, url, base;
const T = 1_791_000_000_000;
const ev = (i, o = {}) => ({ id: `c1.${i}`, seq: i, type: "ui.tab", t: T + i * 1000, data: { tab: `t${i}` }, ...o });
const batch = (o = {}) => ({ v: 1, key: "secret-key", sessionId: "sess-1", clientId: "c1", user: "u_a", role: "player", sentAt: Date.now(), batchSeq: 0, events: [ev(0)], ...o });
const post = (body, headers = {}) => fetch(url, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "Content-Type": "text/plain", ...headers } });

before(async () => {
  col = createCollector({ host: "127.0.0.1", port: 0, db: path.join(dir, "t.db"), ingestKey: "secret-key", origins: ["https://foundry.example"], maxDbMb: 50, retentionDays: 0, sessionIdleMin: 60, rateRps: 50, rateEventsPerMin: 6000 });
  await new Promise((r) => col.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${col.server.address().port}`;
  url = `${base}/v1/ingest`;
});
after(() => new Promise((r) => col.server.close(r)));

test("refuses to start without an ingest key", () => {
  assert.throws(() => createCollector({ db: path.join(dir, "x.db"), ingestKey: "", origins: [] }), /FFR_INGEST_KEY/);
});

test("accepts a valid batch and dedups replays", async () => {
  let r = await post(batch());
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, accepted: 1, duplicates: 0, rejected: [] });
  r = await post(batch({ batchSeq: 1 }));
  assert.equal((await r.json()).duplicates, 1);
});

test("auth: wrong/missing key -> 401; key accepted via header too", async () => {
  assert.equal((await post(batch({ key: "nope" }))).status, 401);
  assert.equal((await post(batch({ key: undefined }))).status, 401);
  const b = batch({ key: undefined, events: [ev(1)] });
  assert.equal((await post(b, { "X-FFR-Key": "secret-key" })).status, 200);
});

test("origin allowlist and CORS preflight", async () => {
  assert.equal((await post(batch({ events: [ev(2)] }), { Origin: "https://evil.example" })).status, 403);
  const ok = await post(batch({ events: [ev(3)] }), { Origin: "https://foundry.example" });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://foundry.example");
  const pre = await fetch(url, { method: "OPTIONS", headers: { Origin: "https://foundry.example", "Access-Control-Request-Method": "POST" } });
  assert.equal(pre.status, 204);
});

test("rejects oversized bodies, bad json and bad schema", async () => {
  assert.equal((await post("x".repeat(600 * 1024))).status, 413);
  assert.equal((await post("{not json")).status, 400);
  assert.equal((await post(batch({ v: 99 }))).status, 400);
  const r = await post(batch({ events: [ev(4), { id: "c1.5", seq: 5, type: "BAD", t: T }] }));
  const j = await r.json();
  assert.equal(j.accepted, 1);
  assert.equal(j.rejected.length, 1);
});

test("no read/export/delete endpoints exist over HTTP", async () => {
  for (const p of ["/v1/sessions", "/v1/export", "/v1/events", "/admin"]) assert.equal((await fetch(base + p)).status, 404);
  assert.equal((await fetch(url)).status, 405); // GET on ingest
  const h = await (await fetch(`${base}/healthz`)).json();
  assert.equal(h.ok, true);
  assert.equal(h.sessions, undefined);
});

test("server-side sanitization strips secrets even if a client sends them", async () => {
  await post(batch({ events: [ev(10, { data: { password: "hunter2", note: "x@y.com" } })] }));
  const db = openDb(col.server && path.join(dir, "t.db"), { readonly: true });
  const row = db.prepare("SELECT data FROM events WHERE id = 'c1.10' AND session_id = 'sess-1'").get();
  assert.deepEqual(JSON.parse(row.data), { note: "[email]" });
  db.close();
});

test("clock skew corrected; out-of-order arrival keeps event-time order", async () => {
  const skew = 120000; // client clock 2 minutes fast
  const now = Date.now();
  const mk = (i) => ({ id: `cs.${i}`, seq: i, type: "ui.tab", t: now + skew + i * 1000 });
  await post(batch({ clientId: "cs", sessionId: "skew", sentAt: now + skew + 5000, events: [mk(3), mk(4)] }));
  await post(batch({ clientId: "cs", sessionId: "skew", sentAt: now + skew + 5000, batchSeq: 1, events: [mk(0), mk(1), mk(2)] }));
  const db = openDb(path.join(dir, "t.db"), { readonly: true });
  const rows = db.prepare("SELECT id, t, tc FROM events WHERE session_id = 'skew' ORDER BY tc").all();
  assert.deepEqual(rows.map((r) => r.id), ["cs.0", "cs.1", "cs.2", "cs.3", "cs.4"]);
  for (const r of rows) assert.ok(Math.abs(r.tc - (r.t - skew)) < 10000, `corrected within tolerance: ${r.tc - (r.t - skew)}`);
  db.close();
});

test("session lifecycle: start label, stop, idle finalization", async () => {
  await post(batch({ sessionId: "life", events: [{ id: "c1.0", seq: 0, type: "session.start", t: T, data: { label: "Night 1" } }] }));
  await post(batch({ sessionId: "life", batchSeq: 1, events: [{ id: "c1.1", seq: 1, type: "session.stop", t: T + 1000 }] }));
  await post(batch({ sessionId: "idle", events: [ev(0)] }));
  const db = openDb(path.join(dir, "t.db"));
  assert.deepEqual({ ...db.prepare("SELECT label, status, end_reason FROM sessions WHERE id = 'life'").get() }, { label: "Night 1", status: "ended", end_reason: "stopped" });
  assert.deepEqual(finalizeIdle(db, 60000, Date.now() + 120000).includes("idle"), true);
  assert.equal(db.prepare("SELECT end_reason FROM sessions WHERE id = 'idle'").get().end_reason, "idle");
  db.close();
});

test("retention and deletion", async () => {
  await post(batch({ sessionId: "old", user: "u_gone", clientId: "cg", events: [{ ...ev(0), id: "cg.0" }] }));
  const db = openDb(path.join(dir, "t.db"));
  assert.equal(deleteUser(db, "u_gone"), 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM clients WHERE user = 'u_gone'").get().n, 0);
  assert.deepEqual(applyRetention(db, 1, Date.now() + 3 * 86400000).length > 0, true);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sessions").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events").get().n, 0);
  assert.equal(deleteSession(db, "nope"), 0);
  db.close();
});

test("rate limiting returns 429 with Retry-After", async () => {
  const c2 = createCollector({ host: "127.0.0.1", port: 0, db: path.join(dir, "r.db"), ingestKey: "k", origins: [], maxDbMb: 50, retentionDays: 0, sessionIdleMin: 60, rateRps: 1, rateEventsPerMin: 6000 });
  await new Promise((r) => c2.server.listen(0, "127.0.0.1", r));
  const u = `http://127.0.0.1:${c2.server.address().port}/v1/ingest`;
  const codes = [];
  for (let i = 0; i < 8; i++) codes.push((await fetch(u, { method: "POST", body: JSON.stringify(batch({ key: "k", batchSeq: i, events: [{ ...ev(i) }] })) })).status);
  assert.ok(codes.includes(429), codes.join(","));
  await new Promise((r) => c2.server.close(r));
});

test("storage cap returns 507", async () => {
  const c3 = createCollector({ host: "127.0.0.1", port: 0, db: path.join(dir, "s.db"), ingestKey: "k", origins: [], maxDbMb: 0, retentionDays: 0, sessionIdleMin: 60, rateRps: 50, rateEventsPerMin: 6000 });
  await new Promise((r) => c3.server.listen(0, "127.0.0.1", r));
  const r = await fetch(`http://127.0.0.1:${c3.server.address().port}/v1/ingest`, { method: "POST", body: JSON.stringify(batch({ key: "k" })) });
  assert.equal(r.status, 507);
  await new Promise((res) => c3.server.close(res));
});
