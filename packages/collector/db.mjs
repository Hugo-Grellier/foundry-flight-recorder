// SQLite storage shared by the collector (writer) and the analysis CLI (reader/admin).
// Uses Node's built-in node:sqlite (Node >= 22.13), no native dependency.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { categoryOf, sanitize } from "../schema/schema.mjs";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, world TEXT, label TEXT, status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL, first_t INTEGER, last_t INTEGER, last_recv INTEGER, ended_at INTEGER, end_reason TEXT
);
CREATE TABLE IF NOT EXISTS clients (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, client_id TEXT NOT NULL,
  user TEXT, role TEXT, first_recv INTEGER, last_recv INTEGER,
  skew_ms REAL, batches INTEGER DEFAULT 0, events INTEGER DEFAULT 0, dups INTEGER DEFAULT 0,
  rejected INTEGER DEFAULT 0, dropped INTEGER DEFAULT 0, max_seq INTEGER DEFAULT -1,
  PRIMARY KEY (session_id, client_id)
);
CREATE TABLE IF NOT EXISTS batches (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, client_id TEXT NOT NULL, batch_seq INTEGER,
  recv INTEGER, sent_at INTEGER, n INTEGER, dups INTEGER, rejected INTEGER, dropped INTEGER
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL, user TEXT, seq INTEGER NOT NULL,
  type TEXT NOT NULL, cat TEXT NOT NULL, sev TEXT,
  t INTEGER NOT NULL, tc INTEGER NOT NULL, recv INTEGER NOT NULL, mono REAL,
  scene TEXT, combat_id TEXT, round INTEGER, turn INTEGER,
  corr TEXT, parent TEXT, span_id TEXT, span_ph TEXT, span_out TEXT, span_kind TEXT,
  dk TEXT, local INTEGER, mode TEXT, sample TEXT, src TEXT, data TEXT,
  PRIMARY KEY (session_id, id)
);
CREATE INDEX IF NOT EXISTS ev_session_time ON events(session_id, tc);
CREATE INDEX IF NOT EXISTS ev_session_type ON events(session_id, type);
CREATE INDEX IF NOT EXISTS ev_client_seq ON events(session_id, client_id, seq);
CREATE INDEX IF NOT EXISTS ev_span ON events(session_id, span_id);
CREATE INDEX IF NOT EXISTS batches_session ON batches(session_id, client_id);
`;

export function openDb(file, { readonly = false } = {}) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file, { readOnly: readonly });
  if (!readonly) db.exec(SCHEMA);
  else db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

/** Write side. One instance per collector process. */
export class Store {
  constructor(db) {
    this.db = db;
    this.q = {
      getSession: db.prepare("SELECT * FROM sessions WHERE id = ?"),
      newSession: db.prepare("INSERT INTO sessions (id, world, created_at, status) VALUES (?, ?, ?, 'active')"),
      touchSession: db.prepare(`UPDATE sessions SET last_recv = ?, first_t = MIN(COALESCE(first_t, ?), ?),
        last_t = MAX(COALESCE(last_t, ?), ?), world = COALESCE(world, ?) WHERE id = ?`),
      startSession: db.prepare("UPDATE sessions SET label = COALESCE(?, label), status = 'active', ended_at = NULL, end_reason = NULL WHERE id = ?"),
      endSession: db.prepare("UPDATE sessions SET status = 'ended', ended_at = ?, end_reason = ? WHERE id = ? AND status = 'active'"),
      getClient: db.prepare("SELECT * FROM clients WHERE session_id = ? AND client_id = ?"),
      newClient: db.prepare(`INSERT INTO clients (session_id, client_id, user, role, first_recv, last_recv, skew_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)`),
      updClient: db.prepare(`UPDATE clients SET last_recv = ?, skew_ms = ?, batches = batches + 1, events = events + ?,
        dups = dups + ?, rejected = rejected + ?, dropped = dropped + ?, max_seq = MAX(max_seq, ?)
        WHERE session_id = ? AND client_id = ?`),
      batch: db.prepare(`INSERT INTO batches (session_id, client_id, batch_seq, recv, sent_at, n, dups, rejected, dropped)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      ins: db.prepare(`INSERT OR IGNORE INTO events (id, session_id, client_id, user, seq, type, cat, sev, t, tc, recv, mono,
        scene, combat_id, round, turn, corr, parent, span_id, span_ph, span_out, span_kind, dk, local, mode, sample, src, data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    };
  }

  /**
   * Persist a validated batch. Returns {accepted, duplicates}.
   * Clock skew: each batch gives (recv - sentAt) = skew + network delay; the minimum over the
   * client's batches is the tightest estimate (NTP-style lower bound). Corrected time tc = t + skew.
   */
  ingest(batch, { recv = Date.now(), rejected = 0 } = {}) {
    const { db, q } = this;
    const sid = batch.sessionId, cid = batch.clientId;
    let accepted = 0, duplicates = 0;
    db.exec("BEGIN");
    try {
      if (!q.getSession.get(sid)) q.newSession.run(sid, batch.world ?? null, recv);
      const sample = recv - batch.sentAt;
      let client = q.getClient.get(sid, cid);
      if (!client) {
        q.newClient.run(sid, cid, batch.user, batch.role ?? null, recv, recv, sample);
        client = { skew_ms: sample };
      }
      const skew = Math.min(client.skew_ms ?? sample, sample);
      let minT = Infinity, maxT = -Infinity, maxSeq = -1;
      for (const e of batch.events) {
        const tc = Math.round(e.t + skew);
        const data = e.data ? JSON.stringify(sanitize(e.data)) : null;
        const r = q.ins.run(e.id, sid, cid, batch.user, e.seq, e.type, categoryOf(e.type), e.sev ?? "info",
          Math.round(e.t), tc, recv, e.mono ?? null, e.scene ?? null, e.combat?.id ?? null, e.combat?.round ?? null,
          e.combat?.turn ?? null, e.corr ?? null, e.parent ?? null, e.span?.id ?? null, e.span?.ph ?? null,
          e.span?.out ?? null, e.span?.kind ?? null, e.dk ?? null, e.local === undefined ? null : e.local ? 1 : 0,
          e.mode ?? null, e.sample ?? null, e.src ?? null, data);
        if (r.changes) {
          accepted++;
          minT = Math.min(minT, tc); maxT = Math.max(maxT, tc); maxSeq = Math.max(maxSeq, e.seq);
          this.#lifecycle(e, sid, tc);
        } else duplicates++;
      }
      q.updClient.run(recv, skew, accepted, duplicates, rejected, batch.dropped ?? 0, maxSeq, sid, cid);
      q.batch.run(sid, cid, batch.batchSeq, recv, Math.round(batch.sentAt), batch.events.length, duplicates, rejected, batch.dropped ?? 0);
      if (accepted) q.touchSession.run(recv, minT, minT, maxT, maxT, batch.world ?? null, sid);
      else db.prepare("UPDATE sessions SET last_recv = ? WHERE id = ?").run(recv, sid);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return { accepted, duplicates };
  }

  #lifecycle(e, sid, tc) {
    if (e.type === "session.start") this.q.startSession.run(typeof e.data?.label === "string" ? e.data.label.slice(0, 120) : null, sid);
    else if (e.type === "session.stop") this.q.endSession.run(tc, "stopped", sid);
  }
}

// ---------------------------------------------------------------------------
// Admin operations (CLI only; never reachable from the ingest endpoint).

/** Mark sessions with no traffic for `idleMs` as ended. Returns ids. */
export function finalizeIdle(db, idleMs, now = Date.now()) {
  const rows = db.prepare("SELECT id FROM sessions WHERE status = 'active' AND last_recv < ?").all(now - idleMs);
  const upd = db.prepare("UPDATE sessions SET status = 'ended', ended_at = last_t, end_reason = 'idle' WHERE id = ?");
  for (const r of rows) upd.run(r.id);
  return rows.map((r) => r.id);
}

export function finalizeSession(db, id, reason = "admin") {
  return db.prepare("UPDATE sessions SET status = 'ended', ended_at = COALESCE(last_t, ?), end_reason = ? WHERE id = ? AND status = 'active'")
    .run(Date.now(), reason, id).changes;
}

export function deleteSession(db, id) {
  db.exec("BEGIN");
  try {
    for (const t of ["events", "batches", "clients"]) db.prepare(`DELETE FROM ${t} WHERE session_id = ?`).run(id);
    const n = db.prepare("DELETE FROM sessions WHERE id = ?").run(id).changes;
    db.exec("COMMIT");
    return n;
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

/** Delete every event of one pseudonymous participant (data subject request). */
export function deleteUser(db, user) {
  db.exec("BEGIN");
  try {
    const n = db.prepare("DELETE FROM events WHERE user = ?").run(user).changes;
    db.prepare("DELETE FROM batches WHERE client_id IN (SELECT client_id FROM clients WHERE user = ?)").run(user);
    db.prepare("DELETE FROM clients WHERE user = ?").run(user);
    db.exec("COMMIT");
    return n;
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

/** Delete sessions whose last activity is older than `days`. Returns deleted ids. */
export function applyRetention(db, days, now = Date.now()) {
  const cutoff = now - days * 86400000;
  const ids = db.prepare("SELECT id FROM sessions WHERE COALESCE(last_recv, created_at) < ?").all(cutoff).map((r) => r.id);
  for (const id of ids) deleteSession(db, id);
  if (ids.length) db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");
  return ids;
}
