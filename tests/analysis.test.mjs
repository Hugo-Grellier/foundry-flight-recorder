// End-to-end on synthetic data: real Recorder -> schema validation -> Store -> analysis/CLI.
// Verifies the toolkit recovers the evidence deliberately planted by tests/fixtures/synth.mjs.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { openDb, Store } from "../packages/collector/db.mjs";
import { generate } from "./fixtures/synth.mjs";
import * as A from "../packages/analysis-cli/analyze.mjs";

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ffr-an-")), "fx.db");
let db, truth, A1, B1;
const cli = (...args) => JSON.parse(execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", "packages/analysis-cli/ffr.mjs", ...args, "--db", file, "--json"], { encoding: "utf8" }));

before(async () => {
  db = openDb(file);
  truth = await generate(new Store(db));
  A1 = truth.a.session; B1 = truth.b.session;
});

test("sessions listed with metadata", () => {
  const s = cli("sessions");
  assert.deepEqual(s.map((x) => x.id).sort(), [A1, B1].sort());
  assert.equal(s.find((x) => x.id === A1).label, "Session 1 - Crypt");
  assert.equal(s.find((x) => x.id === A1).errors, 1);
});

test("info reports coverage: disconnect, crashed client, dropped events, skew", () => {
  const i = cli("info", "synA");
  const old = i.clients.find((c) => c.client === truth.a.p3OldClient);
  assert.equal(old.cleanUnload, false);
  assert.ok(i.clients.find((c) => c.client === truth.a.p3NewClient).cleanUnload);
  assert.equal(i.disconnects.length, 1);
  const kyra = i.clients.find((c) => c.user === "u_kyra");
  assert.ok(kyra.droppedReported > 0 && kyra.seqMissing === kyra.droppedReported, "drops reported and visible as sequence gaps");
  const ezren = i.clients.find((c) => c.user === "u_ezren");
  assert.ok(Math.abs(ezren.skewMs + 90000) < 1000, "90 s fast clock estimated");
  assert.ok(i.limitations.some((l) => /missing from its sequence/.test(l)));
  assert.ok(i.limitations.some((l) => l.includes(truth.a.p3OldClient) && /without unload/.test(l)));
});

test("injected error found with origin module+version and its preceding context", () => {
  const errs = cli("errors", "synA", "--module", "pf2e-toolbelt").filter((g) => g.type === "err.js");
  assert.equal(errs.length, 1);
  assert.equal(errs[0].versions["pf2e-toolbelt"], "2.1.0");
  assert.deepEqual(errs[0].ids, [truth.a.errorId]);
  const w = cli("around", "synA", "--event", truth.a.errorId, "--before", "30s", "--after", "5s");
  const ctx = w.events.filter((e) => e.sample === "context").map((e) => e.type);
  assert.deepEqual(ctx.sort(), ["ui.click", "ui.focus"], "ring-buffer context (normally unsent) recovered");
  assert.ok(w.events.some((e) => e.type === "token.target" && e.user === "u_kyra"));
  assert.ok(w.events.some((e) => e.type === "rec.mode" && e.data.mode === "diagnostic"));
  // events are in corrected-time order across clients
  const ts = w.events.map((e) => Date.parse(e.t));
  assert.deepEqual(ts, [...ts].sort((a, b) => a - b));
});

test("repeated/failed interaction sequence detected without psychological claims", () => {
  const r = cli("repeats", "synA").filter((x) => x.user === "u_ezren");
  const kinds = new Set(r.map((x) => x.kind));
  for (const k of ["target-toggling", "repeated-interaction", "roll-dialog-closed-without-roll", "attack-without-target"]) assert.ok(kinds.has(k), k);
  assert.equal(r.filter((x) => x.kind === "attack-without-target").length, 1, "GM-observed duplicate removed by dk dedup");
  const text = JSON.stringify(r);
  assert.doesNotMatch(text, /confus|frustrat|struggl|didn't understand|angry/i);
});

test("slow turn identified with activity and quiet gap", () => {
  const s = cli("slow", "synA");
  const top = s.slowTurns[0];
  assert.equal(top.actor, "Ezren");
  assert.equal(top.durS, 250);
  assert.equal(top.span, truth.a.turnR1Ezren);
  assert.ok(top.activity["token.target"] >= 6);
  assert.ok(s.stalls.some((x) => x.id === truth.a.stallId && x.attribution[0].origin === "fxmaster"));
});

test("friction marker carries preceding context; note is scrubbed and flagged untrusted", () => {
  const f = cli("friction", "synA", "--before", "90s");
  assert.equal(f.length, 1);
  assert.equal(f[0].id, truth.a.frictionId);
  assert.equal(f[0].noteIsUntrustedText, true);
  assert.match(f[0].note, /\[email\]/);
  assert.ok(f[0].precedingTypes["token.target"] >= 4);
  assert.ok(f[0].precedingErrors.some((e) => /target exactly one/.test(e.msg)));
});

test("anomalies rank and cite evidence", () => {
  const an = cli("anomalies", "synA");
  assert.equal(an[0].severity, "high");
  for (const a of an.filter((x) => x.kind !== "telemetry-gap")) assert.ok(a.evidence.length > 0, a.kind);
  assert.ok(an.some((a) => a.kind === "freeze" && a.evidence.includes(truth.a.stallId)));
});

test("session comparison surfaces the configuration change and its candidate effects", () => {
  const c = cli("compare", "synA", "synB");
  assert.deepEqual(c.config.modules.removed, { fxmaster: "6.0.3" });
  assert.deepEqual(c.config.modules.changed["pf2e-toolbelt"], ["2.1.0", "2.2.0"]);
  assert.deepEqual(c.config.settings.changed["core.visionAnimation"], [true, false]);
  const crypt = c.scenes["Crypt of the Lich"];
  assert.ok(crypt.b.fpsByUser.u_ezren > crypt.a.fpsByUser.u_ezren);
  assert.equal(crypt.a.stalls, 1); assert.equal(crypt.b.stalls, 0);
  assert.equal(c.errors[0].status, "gone");
  assert.ok(c.turns.b.p90S < c.turns.a.p90S);
  assert.match(c.caveat, /not a proven cause/);
});

test("timeline filters: user, type prefix, relative time window", () => {
  const t = cli("timeline", "synA", "--user", "u_ezren", "--type", "token.*,ui.notify", "--from", "+12:00", "--to", "+13:00");
  assert.ok(t.events.length >= 9);
  assert.ok(t.events.every((e) => e.user === "u_ezren" && /^(token\.|ui\.notify)/.test(e.type)));
});

test("digest is bounded and grounded", () => {
  const d = cli("digest", "synA");
  assert.ok(JSON.stringify(d).length < 200000);
  assert.ok(d.limitations.length >= 3);
  assert.ok(d.anomalies.top.length > 0);
  assert.equal(d.pf2e.attacksWithoutTarget.length, 1);
  assert.match(d.howToUse, /untrusted/);
});

test("partially missing data: analysis works when the GM client is absent", () => {
  const f2 = file.replace("fx.db", "nogm.db");
  const d2 = openDb(f2);
  const rows = db.prepare("SELECT * FROM events WHERE session_id = ? AND user != 'u_gm'").all(A1);
  d2.prepare("INSERT INTO sessions (id, created_at, first_t, last_t, status) VALUES (?, ?, ?, ?, 'ended')").run(A1, 0, rows[0].tc, rows.at(-1).tc);
  for (const c of db.prepare("SELECT * FROM clients WHERE session_id = ? AND user != 'u_gm'").all(A1)) d2.prepare("INSERT INTO clients (session_id, client_id, user, role) VALUES (?, ?, ?, ?)").run(A1, c.client_id, c.user, c.role);
  const cols = Object.keys(rows[0]);
  const ins = d2.prepare(`INSERT INTO events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
  for (const r of rows) ins.run(...cols.map((k) => r[k]));
  const inf = A.info(d2, A1);
  assert.ok(inf.limitations.some((l) => /No GM client/.test(l)));
  assert.equal(A.turns(d2, A1).turns.length, 0);
  assert.ok(A.errors(d2, A1).some((g) => g.type === "err.js"));
  assert.ok(A.digest(d2, A1).anomalies.total > 0);
});

test("export writes time-ordered JSONL", () => {
  const out = path.join(path.dirname(file), "exp");
  execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", "packages/analysis-cli/ffr.mjs", "export", "synB", "--out", out, "--db", file]);
  const lines = fs.readFileSync(path.join(out, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(lines.length > 100);
  for (let i = 1; i < lines.length; i++) assert.ok(lines[i].tc >= lines[i - 1].tc);
  assert.ok(fs.existsSync(path.join(out, "session.json")));
});

test("read-only CLI cannot modify data; sql refuses writes", () => {
  assert.throws(() => cli("sql", "DELETE FROM events"));
  assert.throws(() => execFileSync(process.execPath, ["packages/analysis-cli/ffr.mjs", "delete", "synA", "--db", file], { stdio: "pipe" }), /--yes/);
});

test("trend: rows oldest first, config change flagged, error persistence per session", () => {
  const t = cli("trend");
  assert.deepEqual(t.sessions.map((r) => r.session), [A1, B1]);
  assert.equal(t.sessions[1].configChanged, true);
  assert.equal(t.sessions[0].telemetryComplete, false);
  assert.ok(t.sessions[0].frictions === 1 && t.sessions[1].frictions === 0);
  assert.deepEqual(t.errorTrend.find((e) => e.fingerprint.startsWith("pf2e-toolbelt")).counts, [1, 0]);
});

test("pf2e: rules-text lookups per item and strike MAP variants from enriched sheet actions", () => {
  const p = cli("pf2e", "synA");
  assert.equal(p.rulesLookups["Electric Arc"].n, 2);
  assert.deepEqual(p.rulesLookups["Electric Arc"].users, ["u_ezren"]);
  assert.ok(p.strikeVariantsMAP.Longsword[0] >= 1 && p.strikeVariantsMAP.Longsword[1] >= 1);
});

test("untrusted telemetry keys like __proto__ stay ordinary keys (no prototype pollution)", () => {
  const f2 = file.replace("fx.db", "proto.db");
  const d2 = openDb(f2);
  const st = new Store(d2);
  const T = 1_791_000_000_000;
  const ev = (i, type, data) => ({ id: `cp.${i}`, seq: i, type, t: T + i, data });
  st.ingest({ v: 1, sessionId: "proto", clientId: "cp", user: "u_p", sentAt: T, batchSeq: 0, events: [
    ev(0, "ui.action", { action: "toggle-summary", readsRules: true, item: { name: "__proto__" } }),
    ev(1, "ui.action", { action: "strike-attack", variant: "__proto__", item: { name: "constructor" } }),
    ev(2, "pf2e.condition", { op: "create", item: { slug: "__proto__" } }),
    ev(3, "env.modules", { modules: JSON.parse('{"__proto__": {"polluted": true}, "ok": "1"}') }),
  ] }, { recv: T });
  const p = A.pf2eSummary(d2, "proto");
  assert.equal(p.rulesLookups.__proto__.n, 1);
  assert.equal(p.conditionsApplied.__proto__, 1);
  assert.deepEqual(Object.keys(p.strikeVariantsMAP), [], "non-integer variant ignored");
  A.compare(d2, "proto", "proto");
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});
