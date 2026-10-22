import { test } from "node:test";
import assert from "node:assert/strict";
import { Recorder } from "../packages/foundry-module/scripts/recorder.mjs";
import { validateBatch } from "../packages/schema/schema.mjs";

// Deterministic harness: manual clock, manual timers, scripted transport.
function harness(opts = {}) {
  let now = 1_700_000_000_000;
  const timers = [];
  const sent = [];
  let respond = () => ({ ok: true, status: 200 });
  const store = new Map();
  const rec = new Recorder({
    now: () => now, mono: () => now % 1e6,
    setTimer: (f, ms) => { const h = { f, at: now + ms }; timers.push(h); return h; },
    clearTimer: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    fetch: async (url, init) => { const body = JSON.parse(init.body); sent.push(body); return respond(body); },
    beacon: () => true,
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
    ...opts,
  });
  rec.configure({ endpoint: "http://c/v1/ingest", key: "k", sessionId: "s1", user: "u_1", role: "player", world: "w" });
  return {
    rec, sent, store, timers,
    advance: async (ms) => {
      now += ms;
      for (const h of timers.filter((h) => h.at <= now)) { timers.splice(timers.indexOf(h), 1); await h.f(); }
    },
    setRespond: (f) => { respond = f; },
  };
}

test("events are buffered while pending and sent after activation, batches validate", async () => {
  const h = harness();
  h.rec.emit("ui.app.open", { cls: "CharacterSheetPF2e" });
  assert.equal(h.sent.length, 0);
  h.rec.activate();
  await h.advance(0);
  assert.equal(h.sent.length, 1);
  const v = validateBatch(h.sent[0]);
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.equal(v.batch.events.length, 1);
  assert.equal(h.sent[0].sessionId, "s1");
  assert.equal(h.sent[0].events[0].id, `${h.rec.clientId}.0`);
});

test("mode filtering: detailed-level events stay in the ring, then are promoted by an error", async () => {
  const h = harness();
  h.rec.activate();
  h.rec.emit("ui.click", { tag: "button" });    // lvl 1: not sent in normal mode
  h.rec.emit("ui.focus", { field: "x" });        // lvl 1
  await h.advance(6000);
  assert.equal(h.sent.flatMap((b) => b.events).filter((e) => e.type === "ui.click").length, 0);
  h.rec.emit("err.js", { msg: "boom" }, { sev: "error" });
  await h.advance(1000);
  const evs = h.sent.flatMap((b) => b.events);
  const click = evs.find((e) => e.type === "ui.click");
  assert.ok(click, "pre-error context promoted");
  assert.equal(click.sample, "context");
  assert.ok(evs.find((e) => e.type === "rec.mode" && e.data.mode === "diagnostic"));
  assert.equal(h.rec.effectiveMode(), "diagnostic");
  // within the escalation window, detailed events are sent directly
  h.rec.emit("ui.click", { tag: "a" });
  await h.advance(6000);
  assert.equal(h.sent.flatMap((b) => b.events).filter((e) => e.type === "ui.click").length, 2);
  await h.advance(60000);
  assert.equal(h.rec.effectiveMode(), "normal");
});

test("retry with backoff on 5xx/network, no retry on 4xx (no infinite loop)", async () => {
  const h = harness();
  h.rec.activate();
  let calls = 0;
  h.setRespond(() => (++calls <= 2 ? { ok: false, status: 503 } : { ok: true, status: 200 }));
  h.rec.emit("ui.tab", { tab: "spells" });
  await h.advance(0);
  assert.equal(h.rec.queue.length, 1);
  assert.ok(h.rec.backoff >= 750);
  for (let i = 0; i < 10 && h.rec.queue.length; i++) await h.advance(5000);
  assert.equal(h.rec.queue.length, 0);
  assert.equal(h.rec.counters.sent, 1);
  // ids are stable across retries -> collector dedups
  const ids = h.sent.map((b) => b.events[0].id);
  assert.equal(new Set(ids).size, 1);

  h.setRespond(() => ({ ok: false, status: 401 }));
  h.rec.emit("ui.tab", { tab: "feats" });
  await h.advance(6000);
  assert.equal(h.rec.queue.length, 0);
  assert.equal(h.rec.counters.rejected, 1);
});

test("bounded queue drops oldest and reports the loss", async () => {
  const h = harness({ maxQueue: 10, typeBurst: 1000, globalBurst: 1000 });
  h.rec.activate();
  h.setRespond(() => ({ ok: false, status: 0 }));
  for (let i = 0; i < 25; i++) h.rec.emit("ui.action", { i });
  await h.advance(0);
  assert.equal(h.rec.queue.length, 10);
  assert.ok(h.rec.counters.dropped >= 15); // +1 when the rec.loss report itself overflows the full queue
  h.setRespond(() => ({ ok: true, status: 200 }));
  for (let i = 0; i < 10 && h.rec.queue.length; i++) await h.advance(61000);
  const batches = h.sent.filter((b) => b.dropped > 0);
  assert.ok(batches.length, "dropped count transmitted in envelope");
  assert.ok(h.sent.flatMap((b) => b.events).some((e) => e.type === "rec.loss"));
});

test("rate limiting samples out floods but never error triggers", async () => {
  const h = harness();
  h.rec.activate();
  for (let i = 0; i < 500; i++) h.rec.emit("token.control", { i });
  for (let i = 0; i < 5; i++) h.rec.emit("err.js", { msg: `e${i}` }, { sev: "error" });
  assert.ok(h.rec.counters.sampledOut["token.control"] > 400);
  await h.advance(1000);
  for (let i = 0; i < 5; i++) await h.advance(5000);
  const evs = h.sent.flatMap((b) => b.events);
  assert.equal(evs.filter((e) => e.type === "err.js").length, 5);
  const loss = evs.find((e) => e.type === "rec.loss");
  assert.ok(loss?.data.sampledOut["token.control"] > 400);
});

test("spans carry begin/end with duration and outcome", async () => {
  const h = harness();
  h.rec.activate();
  const s = h.rec.span("ui.app", { cls: "X" }, { type: "ui.app.open" });
  await h.advance(2500);
  s.end("closed", {}, { type: "ui.app.close" });
  assert.equal(s.end("again"), null, "double end ignored");
  await h.advance(6000);
  const evs = h.sent.flatMap((b) => b.events);
  const b = evs.find((e) => e.span?.ph === "b"), e = evs.find((e) => e.span?.ph === "e");
  assert.equal(b.span.id, e.span.id);
  assert.equal(e.span.out, "closed");
  assert.equal(e.data.dur, 2500);
  assert.equal(e.parent, b.id);
});

test("unload persists unsent batches; restore resends them with original ids", async () => {
  const h = harness();
  h.rec.activate();
  h.setRespond(() => ({ ok: false, status: 0 }));
  h.rec.emit("ui.tab", { tab: "a" });
  h.rec.emit("ui.tab", { tab: "b" });
  h.rec.unload();
  const stored = JSON.parse(h.store.get("ffr.pending"));
  assert.equal(stored[0].events.length, 2);

  const h2 = harness({ storage: { getItem: () => JSON.stringify(stored), setItem() {}, removeItem() {} } });
  h2.rec.activate();
  const n = await h2.rec.restore();
  assert.equal(n, 2);
  const restored = h2.sent.find((b) => b.restored);
  assert.equal(restored.clientId, h.rec.clientId);
  assert.deepEqual(restored.events.map((e) => e.id), stored[0].events.map((e) => e.id));
});

test("disable (opt-out) drops everything and ignores further events", async () => {
  const h = harness();
  h.rec.emit("ui.tab", { tab: "a" });
  h.rec.disable();
  assert.equal(h.rec.emit("ui.tab", {}), null);
  assert.equal(h.rec.queue.length, 0);
  await h.advance(10000);
  assert.equal(h.sent.length, 0);
});

test("sanitization happens before queueing", () => {
  const h = harness();
  const e = h.rec.emit("ui.action", { password: "hunter2", note: "mail me a@b.co", nested: { cookie: "x", ok: 1 } });
  assert.equal(e.data.password, undefined);
  assert.equal(e.data.note, "mail me [email]");
  assert.deepEqual(e.data.nested, { ok: 1 });
});

test("flush during an in-flight send waits, so emit+flush+disable never loses the last events", async () => {
  const h = harness();
  h.rec.activate();
  let release, calls = 0;
  h.setRespond(() => (calls++ ? { ok: true, status: 200 } : new Promise((r) => { release = () => r({ ok: true, status: 200 }); })));
  h.rec.emit("ui.tab", { tab: "a" });
  const first = h.rec.flush();          // in flight, blocked
  h.rec.emit("session.stop", {});
  const second = h.rec.flush();         // must wait, then send session.stop
  await new Promise((r) => setImmediate(r));
  release();
  await Promise.all([first, second]);
  h.rec.disable();
  assert.ok(h.sent.flatMap((b) => b.events).some((e) => e.type === "session.stop"));
});

test("disable starts a new client instance: no false sequence gaps, no id collisions", async () => {
  const h = harness();
  h.rec.emit("ui.tab", {});
  h.rec.emit("ui.tab", {});
  const before = h.rec.clientId;
  h.rec.disable();
  assert.notEqual(h.rec.clientId, before);
  h.rec.configure({ sessionId: "s2" });
  h.rec.activate();
  h.rec.emit("ui.tab", {});
  await h.advance(0);
  assert.equal(h.sent[0].events[0].seq, 0);
  assert.equal(h.sent[0].clientId, h.rec.clientId);
});

test("lifecycle events are never sampled out, ring-only floods do not consume the send budget", async () => {
  const h = harness();
  h.rec.activate();
  for (let i = 0; i < 3000; i++) h.rec.emit("ui.click", { i });            // lvl 1, ring-only in normal mode
  assert.ok(h.rec.emit("ui.tab", { tab: "x" }).id, "sent-level event still accepted after ring-only flood");
  for (let i = 0; i < 1000; i++) h.rec.emit("ui.action", { i });           // exhaust buckets
  assert.ok(h.rec.emit("session.stop", {}).id);
  assert.ok(h.rec.emit("rec.stop", {}).id);
});

test("close() persists undeliverable events; next activation re-sends them into the old session", async () => {
  const h = harness();
  h.rec.activate();
  h.setRespond(() => ({ ok: false, status: 503 }));
  h.rec.emit("session.stop", {});
  await h.rec.close();
  assert.equal(h.rec.state, "off");
  const stored = JSON.parse(h.store.get("ffr.pending"));
  assert.equal(stored[0].sid, "s1");
  assert.equal(stored[0].events[0].type, "session.stop");
  h.setRespond(() => ({ ok: true, status: 200 }));
  h.rec.configure({ sessionId: "s2" });
  h.rec.activate();
  assert.equal(await h.rec.restore(), 1);
  const resent = h.sent.find((b) => b.restored);
  assert.equal(resent.sessionId, "s1");
  assert.equal(resent.events[0].type, "session.stop");
});
