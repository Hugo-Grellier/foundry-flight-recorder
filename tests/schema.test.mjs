import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBatch, validateEvent, sanitize, scrubString, originsFromStack, topOrigin, errorFingerprint, stableStringify, LIMITS } from "../packages/schema/schema.mjs";

const ev = (o = {}) => ({ id: "c1.0", seq: 0, type: "ui.tab", t: 1_791_000_000_000, data: {}, ...o });
const batch = (o = {}) => ({ v: 1, sessionId: "s1", clientId: "c1", user: "u_x", sentAt: 1_791_000_000_000, batchSeq: 0, events: [ev()], ...o });

test("valid batch passes; bad events are rejected individually", () => {
  const r = validateBatch(batch({ events: [ev(), ev({ id: "bad id!", seq: 1 }), ev({ id: "c1.2", seq: 2, type: "NotAType" }), ev({ id: "c1.3", seq: 3, t: 5 })] }));
  assert.ok(r.ok);
  assert.equal(r.batch.events.length, 1);
  assert.deepEqual(r.rejected.map((x) => x.errors[0]), ["id", "type", "t"]);
});

test("envelope errors reject the whole batch", () => {
  assert.equal(validateBatch(batch({ v: 2 })).ok, false);
  assert.equal(validateBatch(batch({ sessionId: "../etc" })).ok, false);
  assert.equal(validateBatch(batch({ events: Array.from({ length: LIMITS.batchEvents + 1 }, (_, i) => ev({ id: `c1.${i}`, seq: i })) })).ok, false);
  assert.equal(validateBatch(null).ok, false);
});

test("oversized event and malformed span/combat rejected", () => {
  assert.deepEqual(validateEvent(ev({ data: { big: "x".repeat(LIMITS.eventBytes) } })), ["size"]);
  assert.deepEqual(validateEvent(ev({ span: { id: "s", ph: "x" } })), ["span"]);
  assert.deepEqual(validateEvent(ev({ combat: { id: 5 } })), ["combat"]);
  assert.deepEqual(validateEvent(ev({ data: [1] })), ["data"]);
});

test("sanitize: drops sensitive keys and content fields, scrubs secrets, bounds structure", () => {
  const s = sanitize({
    password: "p", apiKey: "k", authorization: "Bearer abc", content: "<p>private chat</p>", text: "typed",
    msg: "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk at https://x.io/a?key=SECRET&b=1 from 192.168.1.20 by a@b.org",
    tokenId: "abc", arr: Array.from({ length: 60 }, (_, i) => i), fn: () => 1, deep: { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } },
    n: NaN, cls: new Map(),
  });
  for (const k of ["password", "apiKey", "authorization", "content", "text"]) assert.equal(s[k], undefined, k);
  assert.equal(s.tokenId, "abc", "Foundry token ids are not secrets");
  assert.match(s.msg, /\[jwt\]/);
  assert.match(s.msg, /key=\[redacted\]&b=1/);
  assert.match(s.msg, /\[ip\]/);
  assert.match(s.msg, /\[email\]/);
  assert.doesNotMatch(s.msg, /SECRET/);
  assert.equal(s.arr.length, LIMITS.arrayItems + 1);
  assert.equal(s.fn, null);
  assert.equal(s.n, null);
  assert.equal(s.cls, "[Map]");
  assert.equal(JSON.stringify(s.deep).includes("[depth]"), true);
});

test("scrubString truncates long strings", () => {
  assert.equal(scrubString("a".repeat(5000)).length, LIMITS.string + 1);
});

test("module attribution from stacks and URLs", () => {
  assert.deepEqual(originsFromStack("at x (http://h/modules/pf2e-toolbelt/main.js:1:2)\n at y (http://h/systems/pf2e/pf2e.mjs:3:4)\n at z (http://h/modules/pf2e-toolbelt/a.js)"), ["pf2e-toolbelt", "system:pf2e"]);
  assert.deepEqual(originsFromStack(""), []);
});

test("error fingerprint normalizes volatile parts", () => {
  const a = errorFingerprint("Token aBcDeFgHiJkLmNoP not found at 12", "m");
  const b = errorFingerprint("Token ZyXwVuTsRqPoNmLk not found at 99", "m");
  assert.equal(a, b);
  assert.notEqual(a, errorFingerprint("Token aBcDeFgHiJkLmNoP not found at 12", "other"));
});

test("stableStringify is key-order independent", () => {
  assert.equal(stableStringify({ b: 1, a: { d: 2, c: [3] } }), stableStringify({ a: { c: [3], d: 2 }, b: 1 }));
});

test("top-frame origin distinguishes the throw site from wrappers lower in the stack", () => {
  const wrapped = "Error: boom\n    at eval (eval at evaluate (:3:1), <anonymous>:1:30)\n    at setTimeout (http://h/modules/music-control/main.js:5:2)";
  assert.equal(topOrigin(wrapped), null);
  assert.deepEqual(originsFromStack(wrapped), ["music-control"]);
  assert.equal(topOrigin("TypeError: x\n    at onShare (http://h/modules/pf2e-toolbelt/main.js:1:2)\n    at y (http://h/systems/pf2e/pf2e.mjs:1:1)"), "pf2e-toolbelt");
  assert.equal(topOrigin("onShare@http://h/modules/tb/main.js:1:2"), "tb"); // Firefox format
});
