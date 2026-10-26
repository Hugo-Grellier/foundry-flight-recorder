// Analysis database (packages/analysis-cli/db.mjs): ingestion invariants and administration.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, Store, applyRetention, deleteSession, deleteUser } from "../packages/analysis-cli/db.mjs";

const T = 1_791_000_000_000;
const ev = (i, o = {}) => ({ id: `c1.${i}`, seq: i, type: "ui.tab", t: T + i * 1000, data: { tab: `t${i}` }, ...o });
const batch = (o = {}) => ({ v: 1, sessionId: "sess-1", clientId: "c1", user: "u_a", role: "player", sentAt: T, batchSeq: 0, events: [ev(0)], ...o });

test("replayed batches are deduplicated by event id", () => {
  const db = openDb(":memory:"), s = new Store(db);
  assert.deepEqual(s.ingest(batch(), { recv: T }), { accepted: 1, duplicates: 0 });
  assert.deepEqual(s.ingest(batch({ batchSeq: 1 }), { recv: T }), { accepted: 0, duplicates: 1 });
});

test("data is sanitized again on ingestion (secrets dropped, emails scrubbed)", () => {
  const db = openDb(":memory:");
  new Store(db).ingest(batch({ events: [ev(10, { data: { password: "hunter2", note: "x@y.com" } })] }), { recv: T });
  assert.deepEqual(JSON.parse(db.prepare("SELECT data FROM events WHERE id = 'c1.10'").get().data), { note: "[email]" });
});

test("clock skew corrected from receive times; out-of-order arrival keeps event-time order", () => {
  const db = openDb(":memory:"), s = new Store(db);
  const skew = 120000; // client clock 2 minutes fast
  const mk = (i) => ({ id: `cs.${i}`, seq: i, type: "ui.tab", t: T + skew + i * 1000 });
  s.ingest(batch({ clientId: "cs", sessionId: "skew", sentAt: T + skew + 5000, events: [mk(3), mk(4)] }), { recv: T + 5000 });
  s.ingest(batch({ clientId: "cs", sessionId: "skew", sentAt: T + skew + 5000, batchSeq: 1, events: [mk(0), mk(1), mk(2)] }), { recv: T + 5200 });
  const rows = db.prepare("SELECT id, t, tc FROM events WHERE session_id = 'skew' ORDER BY tc").all();
  assert.deepEqual(rows.map((r) => r.id), ["cs.0", "cs.1", "cs.2", "cs.3", "cs.4"]);
  for (const r of rows) assert.equal(r.tc, r.t - skew);
});

test("session lifecycle from session.start / session.stop events", () => {
  const db = openDb(":memory:"), s = new Store(db);
  s.ingest(batch({ sessionId: "life", events: [{ id: "c1.0", seq: 0, type: "session.start", t: T, data: { label: "Night 1" } }] }), { recv: T });
  s.ingest(batch({ sessionId: "life", batchSeq: 1, events: [{ id: "c1.1", seq: 1, type: "session.stop", t: T + 1000 }] }), { recv: T + 1000 });
  assert.deepEqual({ ...db.prepare("SELECT label, status, end_reason FROM sessions WHERE id = 'life'").get() }, { label: "Night 1", status: "ended", end_reason: "stopped" });
});

test("retention and deletion", () => {
  const db = openDb(":memory:"), s = new Store(db);
  s.ingest(batch({ sessionId: "old", user: "u_gone", clientId: "cg", events: [{ ...ev(0), id: "cg.0" }] }), { recv: T });
  s.ingest(batch({ sessionId: "old2" }), { recv: T });
  assert.equal(deleteUser(db, "u_gone"), 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM clients WHERE user = 'u_gone'").get().n, 0);
  assert.ok(applyRetention(db, 1, T + 3 * 86400000).length > 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events").get().n, 0);
  assert.equal(deleteSession(db, "nope"), 0);
});
