// Early capture and roll origins (capture.mjs) against minimal Foundry globals.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Recorder } from "../packages/foundry-module/scripts/recorder.mjs";

// Fake Hooks with Foundry's call/callAll semantics (enough for listeners).
const listeners = {};
globalThis.Hooks = {
  on: (h, fn) => (listeners[h] ??= []).push(fn),
  call: (h, ...a) => { for (const fn of listeners[h] ?? []) if (fn(...a) === false) return false; return true; },
  callAll: (h, ...a) => { for (const fn of listeners[h] ?? []) fn(...a); },
};
globalThis.window = new EventTarget();
delete globalThis.game; // installEarly runs before Foundry's game is ready

const { installEarly, installChat } = await import("../packages/foundry-module/scripts/capture.mjs");
const rec = new Recorder({ fetch: async () => ({ ok: true, status: 200 }), setTimer: () => null, clearTimer: () => {} });
const queued = () => rec.queue.map((w) => w.e);
installEarly(rec);

test("boot-time errors are captured before game exists, without recorder self-errors", () => {
  const ev = new Event("error");
  const err = new Error("boom at load");
  err.stack = "Error: boom at load\n    at x (http://h/modules/broken-mod/main.js:1:2)";
  Object.assign(ev, { message: err.message, error: err, filename: "http://h/modules/broken-mod/main.js", lineno: 1, colno: 2 });
  window.dispatchEvent(ev);
  Hooks.callAll("error", "Hooks.#call", new Error("init hook failed"), { hook: "init" });
  const [js, foundry] = queued().filter((e) => e.type !== "rec.mode"); // the first error also escalates to diagnostic
  assert.equal(js.type, "err.js");
  assert.equal(js.data.top, "broken-mod");
  assert.equal(js.data.file, "/modules/broken-mod/main.js");
  assert.equal(foundry.type, "err.foundry");
  assert.equal(rec.counters.selfErrors, 0);
});

test("libWrapper conflicts are recorded and never suppressed", () => {
  const r = Hooks.call("libWrapper.ConflictDetected", "mod-a", "mod-b", "Token.prototype.refresh", []);
  assert.equal(r, true); // libWrapper still warns: our listener returns nothing
  const e = queued().at(-1);
  assert.equal(e.type, "lw.conflict");
  assert.deepEqual(e.data, { a: "mod-a", b: "mod-b", target: "Token.prototype.refresh" });
});

test("a roll's origin is the package on the creating stack, correlated with its chat message", async () => {
  globalThis.game = { user: { id: "u1" }, userId: "u1", users: { activeGM: null } };
  installChat(rec, (h, fn) => Hooks.on(h, fn));
  // A real file under /modules/<id>/ so the stack trace carries that package path.
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ffr-cap-")), "modules", "auto-roller");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "roll.mjs"), "export async function rollIt(doc) { await null; return Hooks.call('preCreateChatMessage', doc, {}, {}, 'u1'); }");
  const { rollIt } = await import(pathToFileURL(path.join(dir, "roll.mjs")));
  await rollIt({ rolls: [{}], timestamp: 123 });
  const o = queued().at(-1);
  assert.equal(o.type, "chat.origin");
  assert.deepEqual(o.data.origins, ["auto-roller"]);
  assert.equal(o.corr, "chat:u1:123");
  Hooks.callAll("preCreateChatMessage", { rolls: [], timestamp: 124 }, {}, {}, "u1"); // not a roll: ignored
  Hooks.callAll("preCreateChatMessage", { rolls: [{}], timestamp: 125 }, {}, {}, "u2"); // another user's roll: theirs to record
  assert.equal(queued().at(-1), o);
  Hooks.callAll("createChatMessage", { id: "m1", isRoll: true, rolls: [], timestamp: 123, speaker: {}, flags: {} }, {}, "u1");
  const m = queued().at(-1);
  assert.equal(m.type, "chat.message");
  assert.equal(m.corr, "chat:u1:123");
});
