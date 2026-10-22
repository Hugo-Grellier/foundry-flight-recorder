#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// Telemetry collector: ingest-only HTTP endpoint + SQLite persistence.
// The ingest key is browser-visible and grants ONLY "append events". There is no read/export/delete
// over HTTP: administration happens through the local CLI (packages/analysis-cli/ffr.mjs) on the host.
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { openDb, Store, finalizeIdle, applyRetention } from "./db.mjs";
import { validateBatch, LIMITS, SCHEMA_VERSION } from "../schema/schema.mjs";

export const VERSION = "0.1.0";

export function configFromEnv(env = process.env) {
  return {
    host: env.FFR_HOST ?? "127.0.0.1",
    port: Number(env.FFR_PORT ?? 4318),
    db: env.FFR_DB ?? "./data/ffr.db",
    ingestKey: env.FFR_INGEST_KEY ?? "",
    insecureNoKey: env.FFR_INSECURE_NO_KEY === "1",
    origins: (env.FFR_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    maxDbMb: Number(env.FFR_MAX_DB_MB ?? 2048),
    retentionDays: Number(env.FFR_RETENTION_DAYS ?? 180),
    sessionIdleMin: Number(env.FFR_SESSION_IDLE_MIN ?? 240),
    rateRps: Number(env.FFR_RATE_RPS ?? 10),          // batches/s per client IP (burst = 4x)
    rateEventsPerMin: Number(env.FFR_RATE_EPM ?? 6000), // events/min per client instance
    trustProxy: env.FFR_TRUST_PROXY === "1",
  };
}

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
const keyOk = (given, expected) => crypto.timingSafeEqual(sha(given ?? ""), sha(expected));

// Token bucket keyed by string; ponytail: in-memory map, pruned every minute (single process).
class Buckets {
  constructor(rate, burst) { this.rate = rate; this.burst = burst; this.m = new Map(); }
  take(key, n = 1, now = Date.now()) {
    let b = this.m.get(key);
    if (!b) this.m.set(key, (b = { tokens: this.burst, at: now }));
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.rate);
    b.at = now;
    if (b.tokens < n) return false;
    b.tokens -= n;
    return true;
  }
  prune(now = Date.now()) { for (const [k, b] of this.m) if (now - b.at > 120000) this.m.delete(k); }
}

export function createCollector(cfg) {
  if (!cfg.ingestKey && !cfg.insecureNoKey) throw new Error("FFR_INGEST_KEY is required (or FFR_INSECURE_NO_KEY=1 for local tests)");
  const db = openDb(cfg.db);
  const store = new Store(db);
  const ipBuckets = new Buckets(cfg.rateRps, cfg.rateRps * 4);
  const evBuckets = new Buckets(cfg.rateEventsPerMin / 60, cfg.rateEventsPerMin);
  const stats = { started: Date.now(), batches: 0, accepted: 0, duplicates: 0, rejectedEvents: 0, refused: {} };
  const refuse = (why) => { stats.refused[why] = (stats.refused[why] ?? 0) + 1; };
  const dbBytes = () => { try { return fs.statSync(cfg.db).size + (fs.statSync(cfg.db + "-wal").size ?? 0); } catch { return 0; } };

  function cors(req, res) {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser client (tests, curl)
    const allowed = cfg.origins.includes("*") || cfg.origins.includes(origin);
    if (!allowed) return false;
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-FFR-Key");
    res.setHeader("Access-Control-Max-Age", "600");
    return true;
  }

  const send = (res, code, body, headers = {}) => {
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
    res.end(JSON.stringify(body));
  };

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > limit) { reject(Object.assign(new Error("too large"), { code: 413 })); req.destroy(); return; }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    const p = url.pathname.replace(/\/+$/, "") || "/";
    if (req.method === "GET" && (p === "/healthz" || p.endsWith("/healthz"))) {
      // Health + ingestion diagnostics only. No session content.
      return send(res, 200, { ok: true, version: VERSION, schema: SCHEMA_VERSION, uptimeS: Math.round((Date.now() - stats.started) / 1000),
        batches: stats.batches, accepted: stats.accepted, duplicates: stats.duplicates, rejectedEvents: stats.rejectedEvents,
        refused: stats.refused, dbMb: Math.round(dbBytes() / 1048576) });
    }
    if (!p.endsWith("/v1/ingest")) return send(res, 404, { error: "not found" });
    if (!cors(req, res)) { refuse("origin"); return send(res, 403, { error: "origin not allowed" }); }
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    if (req.method !== "POST") return send(res, 405, { error: "method" });

    const ip = (cfg.trustProxy && String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim()) || req.socket.remoteAddress;
    if (!ipBuckets.take(ip)) { refuse("rate"); return send(res, 429, { error: "rate limited" }, { "Retry-After": "5" }); }
    if (dbBytes() > cfg.maxDbMb * 1048576) { refuse("storage"); return send(res, 507, { error: "storage limit reached" }); }

    let raw;
    try { raw = await readBody(req, LIMITS.batchBytes); }
    catch (e) { refuse("size"); return send(res, e.code === 413 ? 413 : 400, { error: e.message }); }
    let body;
    try { body = JSON.parse(raw); } catch { refuse("json"); return send(res, 400, { error: "invalid json" }); }

    if (!cfg.insecureNoKey && !keyOk(req.headers["x-ffr-key"] ?? body?.key, cfg.ingestKey)) {
      refuse("key"); return send(res, 401, { error: "bad ingest key" });
    }
    if (body) delete body.key;
    const v = validateBatch(body);
    if (!v.ok) { refuse("schema"); return send(res, 400, { error: "invalid batch", details: v.errors.slice(0, 10) }); }
    if (!evBuckets.take(`${v.batch.sessionId}/${v.batch.clientId}`, v.batch.events.length)) {
      refuse("event-rate"); return send(res, 429, { error: "event rate limited" }, { "Retry-After": "10" });
    }
    const r = store.ingest(v.batch, { rejected: v.rejected.length });
    stats.batches++; stats.accepted += r.accepted; stats.duplicates += r.duplicates; stats.rejectedEvents += v.rejected.length;
    return send(res, 200, { ok: true, accepted: r.accepted, duplicates: r.duplicates, rejected: v.rejected.slice(0, 20) });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error("[ffr] ingest failure:", err?.message);
      if (!res.headersSent) send(res, 500, { error: "internal" });
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;

  const housekeeping = () => {
    try {
      finalizeIdle(db, cfg.sessionIdleMin * 60000);
      if (cfg.retentionDays > 0) applyRetention(db, cfg.retentionDays);
    } catch (e) { console.error("[ffr] housekeeping:", e.message); }
    ipBuckets.prune(); evBuckets.prune();
  };
  const timer = setInterval(housekeeping, 60000);
  timer.unref();
  server.on("close", () => { clearInterval(timer); db.close(); });
  return { server, db, store, stats, housekeeping };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cfg = configFromEnv();
  const { server } = createCollector(cfg);
  server.listen(cfg.port, cfg.host, () => {
    console.log(`[ffr] collector ${VERSION} listening on http://${cfg.host}:${cfg.port} db=${cfg.db} origins=${cfg.origins.join(",") || "(none)"}`);
  });
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.close(() => process.exit(0)));
}
