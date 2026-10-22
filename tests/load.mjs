#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// Bounded load simulation: N clients (real Recorder) push events over real HTTP into a real collector.
// Also measures Recorder.emit() cost. Usage: node tests/load.mjs [clients=12] [eventsPerClient=5000]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCollector } from "../packages/collector/server.mjs";
import { Recorder } from "../packages/foundry-module/scripts/recorder.mjs";

const N = Number(process.argv[2] ?? 12), E = Number(process.argv[3] ?? 5000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ffr-load-"));
const col = createCollector({ host: "127.0.0.1", port: 0, db: path.join(dir, "load.db"), ingestKey: "k", origins: [], maxDbMb: 4096, retentionDays: 0, sessionIdleMin: 600, rateRps: 1000, rateEventsPerMin: 1e7 });
await new Promise((r) => col.server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${col.server.address().port}/v1/ingest`;

// 1) emit() microbenchmark (no network): typical payload, sent level and ring-only level
const bench = new Recorder({ fetch: async () => ({ ok: true, status: 200 }), setTimer: () => ({}), clearTimer() {}, typeBurst: 1e9, typeRate: 1e9, globalBurst: 1e9, globalRate: 1e9, maxQueue: 1e7 });
const payload = { cls: "CharacterSheetPF2e", action: "roll-check", item: { uuid: "Actor.abc.Item.def", type: "action", name: "Strike", slug: "strike" } };
let t = performance.now();
for (let i = 0; i < 50000; i++) bench.emit("ui.action", payload);
const emitUs = ((performance.now() - t) / 50000) * 1000;
t = performance.now();
for (let i = 0; i < 50000; i++) bench.emit("ui.click", payload, { lvl: 9 });
const ringUs = ((performance.now() - t) / 50000) * 1000;

// 2) multi-client HTTP ingestion
const latencies = [];
const statuses = {};
const timedFetch = async (u, init) => { const t0 = performance.now(); const r = await fetch(u, init).catch((e) => ({ ok: false, status: 0, err: e.cause?.code })); latencies.push(performance.now() - t0); statuses[r.status + (r.err ? `:${r.err}` : "")] = (statuses[r.status + (r.err ? `:${r.err}` : "")] ?? 0) + 1; return r; };
const clients = Array.from({ length: N }, (_, i) => {
  const r = new Recorder({ fetch: timedFetch, setTimer: () => ({}), clearTimer() {}, typeBurst: 1e9, typeRate: 1e9, globalBurst: 1e9, globalRate: 1e9, maxQueue: 1e6 });
  r.configure({ endpoint: url, key: "k", sessionId: "load-session", user: `u_${i}`, role: i ? "player" : "gm", world: "w", mode: "detailed" }); // detailed: doc.update (lvl 1) is sent too
  r.activate();
  return r;
});
const t0 = performance.now();
const types = ["ui.action", "ui.tab", "token.target", "perf.window", "chat.message", "doc.update"];
for (let k = 0; k < E; k += 250) {
  for (const c of clients) for (let j = 0; j < 250 && k + j < E; j++) c.emit(types[(k + j) % types.length], { ...payload, j: k + j });
  await Promise.all(clients.map((c) => c.flush()));
}
for (let i = 0; i < 20 && clients.some((c) => c.queue.length); i++) { for (const c of clients) c.backoff = 0; await Promise.all(clients.map((c) => c.flush())); }
const wall = performance.now() - t0;
const stored = col.db.prepare("SELECT COUNT(*) n FROM events").get().n;
const missing = col.db.prepare("SELECT SUM(max_seq + 1 - events) m FROM clients").get().m;
latencies.sort((a, b) => a - b);
const res = {
  env: { node: process.version, cpu: os.cpus()[0]?.model, cores: os.cpus().length },
  emit: { usPerEventSent: +emitUs.toFixed(2), usPerEventRingOnly: +ringUs.toFixed(2) },
  ingest: { clients: N, eventsPerClient: E, stored, expected: N * E, missing, wallMs: Math.round(wall), eventsPerSec: Math.round(stored / (wall / 1000)),
    batchLatencyMs: { p50: +latencies[Math.floor(latencies.length / 2)].toFixed(1), p95: +latencies[Math.floor(latencies.length * 0.95)].toFixed(1), max: +latencies.at(-1).toFixed(1) }, batches: latencies.length, statuses },
  dbMb: +(fs.statSync(path.join(dir, "load.db")).size / 1048576 + (fs.existsSync(path.join(dir, "load.db-wal")) ? fs.statSync(path.join(dir, "load.db-wal")).size / 1048576 : 0)).toFixed(1),
};
console.log(JSON.stringify(res, null, 1));
await new Promise((r) => col.server.close(r));
fs.rmSync(dir, { recursive: true, force: true });
process.exit(stored === N * E ? 0 : 1);
