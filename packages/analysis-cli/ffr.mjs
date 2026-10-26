#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// ffr: investigation & admin CLI over the flight-recorder database. See AGENTS.md.
import { parseArgs } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { openDb, Store, finalizeSession, deleteSession, deleteUser, applyRetention } from "../collector/db.mjs";
import { validateBatch } from "../schema/schema.mjs";
import * as A from "./analyze.mjs";

const HELP = `ffr — Foundry Flight Recorder analysis CLI

Usage: ffr <command> [session] [options]      (session: id, unique prefix, or "latest")
Global: --db <file> (default $FFR_DB or ./data/ffr.db)  --json (machine-readable output)

Investigation (read-only):
  sessions                      list recorded sessions
  info <s>                      metadata, clients, coverage, limitations
  digest <s> [--out f.json]     bounded structured summary: START HERE
  anomalies <s>                 ranked candidate problems with evidence ids
  timeline <s> [--client c] [--user u] [--from t] [--to t] [--type a,b*] [--cat c] [--sev warn] [--limit n]
  around <s> --event <id> | --time <t>  [--before 30s] [--after 10s] [--client c] [--perf]
                                all clients' events around a moment (perf.window summarized unless --perf)
  errors <s> [--module id] [--grep re]  grouped errors/warnings with origin module+version
  turns <s> [--round n]         combat turns: duration, activity, quiet gaps
  slow <s>                      slow turns, freezes, slow scene loads, long idle
  perf <s> [--scene id] [--client c]   fps / frame time / long frames per scene & client
  repeats <s>                   repeated/abandoned interaction patterns
  friction <s>                  participant friction markers with preceding context
  pf2e <s>                      PF2e checks/outcomes/conditions/rerolls/actions
  usage <s>                     per-user interaction counts, top windows/tabs
  gaps <s>                      missing telemetry (sequence gaps) per client
  compare <a> <b>               config diff + perf/errors/turns/friction deltas
  trend [--last 10] [--world w] metrics per session over time + recurring errors
  export <s> [--out dir]        events.jsonl (time-ordered) + session.json
  sql "<select ...>"            read-only SQL (tables: sessions, clients, batches, events)

Administration (local only, modifies data):
  import <dir|file...>          load batch files stored on the Foundry server (module storage, no collector)
                                into the database (created if missing); idempotent (events dedup by id)
  finalize <s>                  mark a session ended
  delete <s> --yes              delete a session and all its events
  delete-user <pseudo> --yes    delete all events of one participant
  retention --days N --yes      delete sessions older than N days

Times: "+12:30" (from session start), ISO date, or epoch ms. Durations: 30s, 2m, 500ms.`;

const { values: o, positionals: pos } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: "string" }, json: { type: "boolean" }, out: { type: "string" }, yes: { type: "boolean" }, help: { type: "boolean", short: "h" },
    client: { type: "string" }, user: { type: "string" }, from: { type: "string" }, to: { type: "string" }, type: { type: "string" },
    cat: { type: "string" }, sev: { type: "string" }, limit: { type: "string" }, event: { type: "string" }, time: { type: "string" },
    before: { type: "string" }, after: { type: "string" }, module: { type: "string" }, grep: { type: "string" }, round: { type: "string" },
    scene: { type: "string" }, days: { type: "string" }, perf: { type: "boolean" }, last: { type: "string" }, world: { type: "string" },
  },
});

const [cmd, ...args] = pos;
if (!cmd || o.help) { console.log(HELP); process.exit(0); }
const dbFile = o.db ?? process.env.FFR_DB ?? "./data/ffr.db";
const ADMIN = new Set(["import", "finalize", "delete", "delete-user", "retention"]);
if (!fs.existsSync(dbFile) && cmd !== "import") fail(`database not found: ${dbFile} (set --db or FFR_DB)`);
const db = openDb(dbFile, { readonly: !ADMIN.has(cmd) });

function fail(msg) { console.error(`ffr: ${msg}`); process.exit(2); }
const sess = (x) => A.resolveSession(db, x);
const list = (s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined);
const needYes = (what) => { if (!o.yes) fail(`${what} is destructive: re-run with --yes`); };

function print(v) {
  if (o.json) return console.log(JSON.stringify(v, null, 1));
  console.log(human(v, 0));
}
// Readable indented output; long arrays of events print one line each.
function human(v, d) {
  const pad = "  ".repeat(d);
  if (v === null || v === undefined) return "-";
  if (typeof v !== "object") return String(v);
  if (Array.isArray(v)) {
    if (!v.length) return "(none)";
    if (v.every((x) => x === null || typeof x !== "object")) return v.join(", ").length < 120 ? v.join(", ") : v.map((x) => `\n${pad}- ${x}`).join("");
    return v.map((x) => `\n${pad}- ${line(x, d)}`).join("");
  }
  return Object.entries(v).map(([k, x]) => `\n${pad}${k}: ${typeof x === "object" && x !== null && !Array.isArray(x) && Object.keys(x).length > 4 ? human(x, d + 1) : Array.isArray(x) ? human(x, d + 1) : inline(x)}`).join("");
}
const inline = (x) => (x !== null && typeof x === "object" ? JSON.stringify(x) : String(x ?? "-"));
function line(x, d) {
  if (x.type && x.at && x.id) {
    const { at, type, user, client, id, data, ...rest } = x;
    return `${at} ${type} [${user ?? ""}/${String(client ?? "").slice(0, 7)}] ${data ? JSON.stringify(data).slice(0, 220) : ""} ${Object.keys(rest).length ? JSON.stringify(rest) : ""} #${id}`;
  }
  return Object.keys(x).length <= 6 ? inline(x) : human(x, d + 1);
}

try {
  switch (cmd) {
    case "sessions": print(A.listSessions(db)); break;
    case "info": print(A.info(db, sess(args[0]))); break;
    case "gaps": print(A.gaps(db, sess(args[0]))); break;
    case "digest": {
      const r = A.digest(db, sess(args[0]));
      if (o.out) { fs.writeFileSync(o.out, JSON.stringify(r, null, 1)); console.log(`wrote ${o.out}`); } else print(r);
      break;
    }
    case "anomalies": print(A.anomalies(db, sess(args[0]))); break;
    case "timeline": {
      const s = sess(args[0]); const t0 = A.sessionT0(db, s);
      print(A.timeline(db, s, { client: o.client, user: o.user, from: A.parseTime(o.from, t0), to: A.parseTime(o.to, t0), types: list(o.type), cats: list(o.cat), minSev: o.sev, limit: Number(o.limit ?? 500) }));
      break;
    }
    case "around": {
      const s = sess(args[0]); const t0 = A.sessionT0(db, s);
      print(A.around(db, s, { event: o.event ?? args[1], time: A.parseTime(o.time, t0), before: A.parseDuration(o.before, 30000), after: A.parseDuration(o.after, 10000), client: o.client, limit: Number(o.limit ?? 300), includePerf: o.perf }));
      break;
    }
    case "errors": print(A.errors(db, sess(args[0]), { module: o.module, grep: o.grep, limit: Number(o.limit ?? 50) })); break;
    case "turns": print(A.turns(db, sess(args[0]), { round: o.round })); break;
    case "slow": print(A.slow(db, sess(args[0]))); break;
    case "perf": print(A.perf(db, sess(args[0]), { scene: o.scene, client: o.client })); break;
    case "repeats": print(A.repeats(db, sess(args[0]))); break;
    case "friction": print(A.friction(db, sess(args[0]), { before: A.parseDuration(o.before, 30000) })); break;
    case "pf2e": print(A.pf2eSummary(db, sess(args[0]))); break;
    case "usage": print(A.usage(db, sess(args[0]))); break;
    case "trend": print(A.trend(db, { last: Number(o.last ?? 10), world: o.world })); break;
    case "compare": if (args.length < 2) fail("compare needs two sessions"); print(A.compare(db, sess(args[0]), sess(args[1]))); break;
    case "export": {
      const s = sess(args[0]);
      const dir = o.out ?? `./export/${s}`;
      fs.mkdirSync(dir, { recursive: true });
      const fd = fs.openSync(path.join(dir, "events.jsonl"), "w");
      let n = 0;
      for (const r of db.prepare("SELECT * FROM events WHERE session_id = ? ORDER BY tc, client_id, seq").iterate(s)) { fs.writeSync(fd, JSON.stringify(A.parseRow(r)) + "\n"); n++; }
      fs.closeSync(fd);
      fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify(A.info(db, s), null, 1));
      console.log(`exported ${n} events to ${dir}`);
      break;
    }
    case "sql": {
      if (!/^\s*(select|with)\b/i.test(args[0] ?? "")) fail("only SELECT statements are allowed");
      print(db.prepare(args[0]).all()); // the database is opened read-only for this command
      break;
    }
    case "import": {
      if (!args.length) fail("import needs a directory or file (e.g. a copy of Data/modules/foundry-flight-recorder/storage)");
      const files = args.flatMap((a) => (fs.statSync(a).isDirectory() ? fs.readdirSync(a, { recursive: true }).map((f) => path.join(a, f)) : [a]))
        .filter((f) => f.endsWith(".json") && fs.statSync(f).isFile())
        .map((f) => ({ f, mtime: fs.statSync(f).mtimeMs })).sort((a, b) => a.mtime - b.mtime);
      const store = new Store(db);
      const r = { files: files.length, accepted: 0, duplicates: 0, rejectedEvents: 0, invalidFiles: [] };
      for (const { f, mtime } of files) {
        let v;
        try { const body = JSON.parse(fs.readFileSync(f, "utf8")); delete body.key; v = validateBatch(body); } catch (e) { v = { ok: false, errors: [e.message] }; }
        if (v.ok && path.basename(path.dirname(f)) !== v.batch.user) v = { ok: false, errors: [`user ${v.batch.user} is not this participant's folder`] };
        const owner = v.ok && db.prepare("SELECT user FROM clients WHERE session_id = ? AND client_id = ?").get(v.batch.sessionId, v.batch.clientId);
        if (owner && owner.user !== v.batch.user) v = { ok: false, errors: [`client ${v.batch.clientId} belongs to another participant`] };
        if (!v.ok) { r.invalidFiles.push(`${f}: ${String(v.errors[0]).slice(0, 120)}`); continue; }
        const foreign = v.batch.events.filter((e) => e.id !== `${v.batch.clientId}.${e.seq}`);
        v.batch.events = v.batch.events.filter((e) => !foreign.includes(e));
        r.rejectedEvents += foreign.length;
        // The file's mtime is the Foundry server's write time: it stands in for the collector's receive time (clock skew).
        const x = store.ingest(v.batch, { recv: mtime, rejected: v.rejected.length });
        r.accepted += x.accepted; r.duplicates += x.duplicates; r.rejectedEvents += v.rejected.length;
      }
      print(r); break;
    }
    case "finalize": print({ finalized: finalizeSession(db, sess(args[0])) }); break;
    case "delete": { const s = sess(args[0]); needYes(`delete session ${s}`); print({ deleted: deleteSession(db, s) }); break; }
    case "delete-user": needYes(`delete user ${args[0]}`); print({ deletedEvents: deleteUser(db, args[0]) }); break;
    case "retention": { if (!o.days) fail("--days required"); needYes("retention"); print({ deletedSessions: applyRetention(db, Number(o.days)) }); break; }
    default: fail(`unknown command ${cmd}\n\n${HELP}`);
  }
} catch (e) {
  fail(e.message);
}
