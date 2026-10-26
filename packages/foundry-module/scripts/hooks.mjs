// Hook attribution, veto detection and per-package hook timing.
//
// Foundry's Hooks.#call invokes `entry.fn` of each registered entry and handles `once`, errors (onError) and
// the `false` short-circuit of Hooks.call itself. We never replace Hooks.call/callAll: we swap `entry.fn` for a
// wrapper that calls the original with the same `this`/arguments and returns or throws exactly what it does.
//   - Tagging (always): Hooks.on records which package registered each callback (stack at registration).
//   - Vetoes (always): listeners of pre* hooks are wrapped to report a `false` return (an action cancelled).
//   - Timing (diagnostic mode only): every listener is wrapped and its synchronous time summed per package;
//     unwrapped again when timing stops. Suspended automatically when our own overhead is too high or when
//     another tool replaces Hooks.call/callAll (its own wrapping would distort the numbers).
// Foundry specifics are injected so this file is unit-tested under Node.
import { originsFromStack } from "./schema.mjs";

const ORIG = Symbol("ffr.hooks.orig");

/**
 * @param {object} o
 * @param {object} o.Hooks                      Foundry's Hooks class
 * @param {string} o.ownId                      this module's id (never the registering package of its own frames)
 * @param {(v:{hook:string, pkg:string, fn:string})=>void} o.onVeto
 * @param {()=>number} [o.now]
 * @param {number} [o.maxOverhead=0.02]         suspend timing above this share of wall time
 */
export function installHookProfiler({ Hooks, ownId, onVeto, now = () => performance.now(), maxOverhead = 0.02 }) {
  const tags = new WeakMap(); // original fn -> registering package
  let timing = false, suspended = null, perCallMs = 0, refs = null;
  let stats = new Map(), calls = 0;

  const pkgOf = (stack) => originsFromStack(stack).find((p) => p !== ownId) ?? "core";
  const isPre = (hook) => typeof hook === "string" && hook.startsWith("pre");

  function wrap(entry) {
    const fn = entry.fn;
    if (typeof fn !== "function" || fn[ORIG]) return;
    const pkg = tags.get(fn) ?? "untagged";
    const pre = isPre(entry.hook);
    const w = function (...args) {
      if (!timing) {
        const r = fn.apply(this, args);
        if (pre && r === false) veto(entry.hook, pkg, fn);
        return r;
      }
      const t = now();
      let r;
      try { r = fn.apply(this, args); return r; } finally {
        const ms = now() - t;
        calls++;
        let s = stats.get(pkg);
        if (!s) stats.set(pkg, (s = { calls: 0, ms: 0, max: 0, maxHook: null }));
        s.calls++; s.ms += ms;
        if (ms > s.max) { s.max = ms; s.maxHook = entry.hook; }
        if (pre && r === false) veto(entry.hook, pkg, fn);
      }
    };
    Object.defineProperty(w, "name", { value: fn.name }); // Foundry names the function in hook error messages
    w[ORIG] = fn;
    entry.fn = w;
  }
  const unwrap = (entry) => { if (entry.fn?.[ORIG] && !isPre(entry.hook)) entry.fn = entry.fn[ORIG]; };
  // Foundry defines each hook's list with Object.defineProperty: non-enumerable, so Object.values() misses them.
  const entries = () => { const ev = Hooks.events ?? {}; return Object.getOwnPropertyNames(ev).flatMap((h) => ev[h]); };
  const veto = (hook, pkg, fn) => { try { onVeto({ hook, pkg, fn: fn.name || null }); } catch { /* never break the hook */ } };

  const on = Hooks.on, off = Hooks.off;
  Hooks.on = function (hook, fn, options) {
    if (typeof fn === "function" && !tags.has(fn)) { try { tags.set(fn, pkgOf(new Error().stack)); } catch { /* untagged */ } }
    const id = on.call(this, hook, fn, options);
    if (isPre(hook) || timing) { try { const e = Hooks.events?.[hook]?.find((x) => x.id === id); if (e) wrap(e); } catch { /* left unwrapped */ } }
    return id;
  };
  // Foundry removes a function by identity (entry.fn === fn): translate the original to its wrapper.
  Hooks.off = function (hook, fn) {
    if (typeof fn === "function") {
      const e = Hooks.events?.[hook]?.find((x) => x.fn === fn || x.fn?.[ORIG] === fn);
      if (e) fn = e.fn;
    }
    return off.call(this, hook, fn);
  };
  for (const e of entries()) if (isPre(e.hook)) wrap(e); // registered before this module loaded: vetoes still seen

  function calibrate() {
    const e = { hook: "ffrCalibrate", fn: () => {} };
    wrap(e);
    const n = 2000, t = now();
    for (let i = 0; i < n; i++) e.fn();
    perCallMs = Math.max(0, (now() - t) / n);
  }

  return {
    get timing() { return timing; },
    /** Start/stop timing (diagnostic mode while recording). */
    setTiming(onOff) {
      if (onOff === timing) return;
      timing = onOff;
      stats = new Map(); calls = 0; suspended = null;
      if (timing) {
        refs = { call: Hooks.call, callAll: Hooks.callAll };
        calibrate();
        stats = new Map(); calls = 0; // calibration calls are not session data
        for (const e of entries()) wrap(e);
      } else for (const e of entries()) unwrap(e);
    },
    /**
     * Per-window summary, then reset. Applies the guards: returns {suspended: reason} once when timing stops.
     * @param {number} windowMs wall time covered
     */
    flush(windowMs) {
      if (!timing) return null;
      const overheadMs = calls * perCallMs;
      const top = Object.fromEntries([...stats.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 12)
        .map(([p, s]) => [p, { calls: s.calls, ms: Math.round(s.ms * 10) / 10, max: Math.round(s.max * 10) / 10, maxHook: s.maxHook }]));
      stats = new Map(); calls = 0;
      let reason = null;
      if (overheadMs > windowMs * maxOverhead) reason = "overhead";
      else if (Hooks.call !== refs.call || Hooks.callAll !== refs.callAll) reason = "hooks-replaced";
      if (reason) { this.setTiming(false); suspended = reason; }
      return { top, overheadMs: Math.round(overheadMs * 10) / 10, suspended: reason };
    },
    status: () => ({ timing, suspended, perCallUs: Math.round(perCallMs * 1000 * 100) / 100 }),
  };
}
