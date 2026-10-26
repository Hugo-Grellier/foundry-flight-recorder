// hooks.mjs against a Hooks class reproducing Foundry 14.369's (scripts/foundry.mjs: on/once/off/call/callAll/#call).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { installHookProfiler } from "../packages/foundry-module/scripts/hooks.mjs";

function makeHooks() {
  const errors = [];
  class Hooks {
    static #events = {};
    static #ids = new Map();
    static #id = 1;
    static get events() { return this.#events; }
    static on(hook, fn, { once = false } = {}) {
      const id = this.#id++;
      if (!(hook in this.#events)) Object.defineProperty(this.#events, hook, { value: [], writable: false });
      const entry = { hook, id, fn, once };
      this.#events[hook].push(entry);
      this.#ids.set(id, entry);
      return id;
    }
    static once(hook, fn) { return this.on(hook, fn, { once: true }); }
    static off(hook, fn) {
      if (typeof fn === "number") { const e = this.#ids.get(fn); if (!e) return; this.#ids.delete(fn); const ev = this.#events[e.hook]; ev.splice(ev.findIndex((h) => h.id === fn), 1); return; }
      const ev = this.#events[hook]; if (!ev) return;
      const i = ev.findIndex((h) => h.fn === fn); if (i < 0) return;
      this.#ids.delete(ev[i].id); ev.splice(i, 1);
    }
    static callAll(hook, ...args) { if (!(hook in this.#events)) return; for (const e of Array.from(this.#events[hook])) this.#call(e, args); }
    static call(hook, ...args) {
      if (!(hook in this.#events)) return true;
      for (const e of Array.from(this.#events[hook])) if (this.#call(e, args) === false) return false;
      return true;
    }
    static #call(entry, args) {
      const { hook, id, fn, once } = entry;
      if (once) this.off(hook, id);
      try { return entry.fn(...args); } catch (err) { errors.push({ hook, name: fn?.name, err }); }
    }
  }
  return { Hooks, errors };
}

// A registration from a real file under /modules/<id>/ so the stack carries the package.
async function moduleFile(id, src) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ffr-hk-")), "modules", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "m.mjs"), src);
  return import(pathToFileURL(path.join(dir, "m.mjs")));
}

test("Foundry semantics are preserved: once, off by function, call short-circuit, errors, this", async () => {
  const { Hooks, errors } = makeHooks();
  const vetoes = [];
  const prof = installHookProfiler({ Hooks, ownId: "foundry-flight-recorder", onVeto: (v) => vetoes.push(v) });
  prof.setTiming(true);
  let n = 0;
  Hooks.once("ready", () => n++);
  Hooks.callAll("ready"); Hooks.callAll("ready");
  assert.equal(n, 1);
  const f = () => n++;
  Hooks.on("updateActor", f);
  Hooks.off("updateActor", f); // by the original function, although entry.fn is our wrapper
  Hooks.callAll("updateActor");
  assert.equal(n, 1);
  let after = false;
  Hooks.on("preCreateItem", function named() { return false; });
  Hooks.on("preCreateItem", () => { after = true; });
  assert.equal(Hooks.call("preCreateItem", {}), false);
  assert.equal(after, false);
  Hooks.on("renderX", function boom() { throw new Error("x"); });
  Hooks.callAll("renderX");
  assert.equal(errors[0].err.message, "x");
  assert.equal(errors[0].name, "boom"); // Foundry's "Error thrown in hooked function 'boom'"
  let self;
  Hooks.on("thisCheck", function () { self = this; });
  Hooks.callAll("thisCheck");
  assert.equal(self.hook, "thisCheck"); // #call invokes entry.fn with the entry as `this`
  assert.equal(vetoes.length, 1);
});

test("registering package is tagged; vetoes are reported always, timing per package only when on", async () => {
  const { Hooks } = makeHooks();
  const vetoes = [];
  Hooks.on("preUpdateToken", () => false); // registered before the recorder loaded: untagged, still wrapped
  globalThis.HooksUnderTest = Hooks;
  const prof = installHookProfiler({ Hooks, ownId: "foundry-flight-recorder", onVeto: (v) => vetoes.push(v) });
  await moduleFile("blocker", "export const r = globalThis.HooksUnderTest.on('preCreateChatMessage', function deny() { return false; }); globalThis.HooksUnderTest.on('refreshToken', function slow() { const t = Date.now(); while (Date.now() - t < 5); });");
  Hooks.call("preUpdateToken");
  Hooks.call("preCreateChatMessage");
  assert.deepEqual(vetoes, [{ hook: "preUpdateToken", pkg: "untagged", fn: null }, { hook: "preCreateChatMessage", pkg: "blocker", fn: "deny" }]);
  Hooks.callAll("refreshToken");
  assert.equal(prof.flush(10000), null); // timing off: nothing measured
  prof.setTiming(true);
  Hooks.callAll("refreshToken"); Hooks.callAll("refreshToken");
  const w = prof.flush(10000);
  assert.equal(w.top.blocker.calls, 2);
  assert.deepEqual(Object.keys(w.top), ["blocker"]); // calibration calls are not counted
  assert.ok(w.top.blocker.ms >= 9);
  assert.equal(w.top.blocker.maxHook, "refreshToken");
  assert.equal(w.suspended, null);
  prof.setTiming(false);
  const entry = Hooks.events.refreshToken[0];
  assert.equal(entry.fn.name, "slow");
  assert.equal(Object.getOwnPropertySymbols(entry.fn).length, 0); // unwrapped: back to the original function
  assert.ok(Object.getOwnPropertySymbols(Hooks.events.preCreateChatMessage[0].fn).length); // pre* stay wrapped
});

test("guards: timing suspends on excessive overhead or when Hooks.call is replaced", () => {
  const { Hooks } = makeHooks();
  let t = 0;
  const prof = installHookProfiler({ Hooks, ownId: "x", onVeto: () => {}, now: () => (t += 1) }); // 1 ms per now(): huge overhead
  prof.setTiming(true);
  Hooks.on("refreshToken", () => {});
  for (let i = 0; i < 300; i++) Hooks.callAll("refreshToken");
  assert.equal(prof.flush(10000).suspended, "overhead");
  assert.equal(prof.timing, false);

  const h2 = makeHooks().Hooks;
  const p2 = installHookProfiler({ Hooks: h2, ownId: "x", onVeto: () => {} });
  p2.setTiming(true);
  const orig = h2.call;
  h2.call = function (...a) { return orig.apply(this, a); }; // another profiler patches Hooks.call
  assert.equal(p2.flush(10000).suspended, "hooks-replaced");
  assert.equal(p2.status().suspended, "hooks-replaced");
});
