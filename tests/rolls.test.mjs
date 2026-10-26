// Analysis of roll origins, libWrapper conflicts and latency on a hand-built session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, Store } from "../packages/collector/db.mjs";
import * as A from "../packages/analysis-cli/analyze.mjs";

const T = 1_750_000_000_000;
let seq = 0;
const ev = (type, t, data, extra = {}) => ({ id: `c1.${seq}`, seq: seq++, type, t: T + t, mono: t, data, ...extra });
const roll = (t, ts, origins, actor = "a1", formula = "1d6") => [
  ev("chat.origin", t, { rolls: 1, origins, macro: false, stack: "" }, { corr: `chat:u1:${ts}` }),
  ev("chat.message", t + 50, { msg: `m${ts}`, isRoll: true, rolls: [{ formula }], speaker: { actor } }, { corr: `chat:u1:${ts}` }),
];
const db = openDb(":memory:");
new Store(db).ingest({ v: 1, sessionId: "s1", clientId: "c1", user: "u_1", sentAt: T, batchSeq: 0, events: [
  ev("session.start", 0, {}),
  ...roll(1000, 1, ["system:pf2e", "pf2e-toolbelt", "lib-wrapper"]),      // module automation
  ...roll(2000, 2, ["system:pf2e", "persistent-damage-auto"]),             // a second module, same roll: duplicate
  ...roll(9000, 3, []),                                                    // core UI click, far later
  ...roll(9500, 4, ["system:pf2e"], "a2", "1d20+5"),
  ...roll(9700, 5, ["system:pf2e"], "a2", "1d20+5"),                       // same initiator again (e.g. MAP): not a duplicate
  ev("lw.conflict", 3000, { a: "mod-a", b: "mod-b", target: "Token.prototype.refresh" }),
  ev("lw.conflict", 3100, { a: "mod-a", b: "mod-b", target: "Token.prototype.refresh" }),
  ev("perf.window", 10000, { frames: 600, fps: 60, p95: 17, max: 20, latencyMs: 40 }),
  ev("perf.window", 20000, { frames: 600, fps: 60, p95: 17, max: 20, latencyMs: 300, hookTime: { "slow-mod": { calls: 50, ms: 400 }, "system:pf2e": { calls: 9, ms: 20 } } }),
  ev("hook.veto", 21000, { hook: "preCreateChatMessage", pkg: "blocker", fn: "deny" }),
  ev("hook.veto", 21500, { hook: "preCreateChatMessage", pkg: "blocker", fn: "deny" }),
  ev("friction.mark", 30000, { cat: "broken" }),
  ev("hook.veto", 90000, { hook: "preUpdateToken", pkg: "walls-mod", fn: null }),
] }, { recv: T });

test("roll initiators: bottom-most package, wrappers skipped, core UI when no package", () => {
  const r = A.rolls(db, "s1");
  assert.equal(r.total, 5);
  assert.deepEqual(r.byInitiator, { "pf2e-toolbelt": 1, "persistent-damage-auto": 1, "core-ui": 1, "system:pf2e": 2 });
  assert.equal(r.duplicates.length, 1);
  assert.deepEqual(r.duplicates[0].initiators, ["pf2e-toolbelt", "persistent-damage-auto"]);
  assert.equal(r.duplicates[0].ids.length, 4);
});

test("anomalies report the libWrapper conflict once and the duplicate roll; perf reports latency", () => {
  const an = A.anomalies(db, "s1");
  const c = an.filter((a) => a.kind === "wrapper-conflict");
  assert.equal(c.length, 1);
  assert.equal(c[0].evidence.length, 2);
  assert.equal(an.filter((a) => a.kind === "duplicate-roll").length, 1);
  const p = A.perf(db, "s1").byClientScene[0];
  assert.equal(p.latencyMsMax, 300);
  assert.equal(p.latencyMsMedian, 300); // project median: upper middle value
  assert.deepEqual(p.hookMsPerMinByPackage, { "slow-mod": 2400, "system:pf2e": 120 }); // one profiled 10 s window
  const v = an.filter((a) => a.kind === "hook-veto");
  assert.deepEqual(v.map((x) => [x.package, x.severity, x.evidence.length]), [["blocker", "medium", 2], ["walls-mod", "low", 1]]);
});
