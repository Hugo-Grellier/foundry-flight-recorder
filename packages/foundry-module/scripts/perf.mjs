// Performance sampling: rAF frame times, long tasks, Long Animation Frames (with script attribution),
// memory, and counts of expensive canvas hooks. Aggregated into one perf.window event per window.
import { originsFromStack } from "./schema.mjs";

const WINDOW_MS = 10000;
const STALL_MS = 1000;      // a single frame this long is a user-visible freeze
const LOAF_DETAIL_MS = 200; // LoAF entries above this get their own event in detailed/diagnostic mode
const COUNTED_HOOKS = ["sightRefresh", "lightingRefresh", "initializeVisionSources", "initializeLightSources", "refreshToken", "canvasPan", "drawToken", "renderChatMessageHTML"];

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);
const round = (n) => (n == null ? null : Math.round(n * 10) / 10);

export function installPerf(rec) {
  let frames = [], last = 0, longTasks = { n: 0, ms: 0 }, loaf = { n: 0, ms: 0, blocking: 0, origins: {} };
  let hookCounts = Object.fromEntries(COUNTED_HOOKS.map((h) => [h, 0]));
  let hiddenMs = 0, hiddenAt = document.hidden ? performance.now() : null;
  const recentLoaf = []; // for stall attribution

  for (const h of COUNTED_HOOKS) Hooks.on(h, () => { hookCounts[h]++; });

  const frame = (ts) => {
    if (last && !document.hidden) {
      const dt = ts - last;
      frames.push(dt);
      if (dt >= STALL_MS) {
        const attribution = recentLoaf.filter((l) => l.end >= ts - dt - 50).flatMap((l) => l.scripts).slice(0, 8);
        rec.emit("perf.stall", { ms: Math.round(dt), attribution, hooks: { ...hookCounts } }, { sev: "warn" });
      }
    }
    last = document.hidden ? 0 : ts;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) hiddenAt = performance.now();
    else if (hiddenAt != null) { hiddenMs += performance.now() - hiddenAt; hiddenAt = null; last = 0; }
  });

  const supported = globalThis.PerformanceObserver?.supportedEntryTypes ?? [];
  if (supported.includes("longtask")) {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) { longTasks.n++; longTasks.ms += e.duration; }
    }).observe({ type: "longtask" });
  }
  if (supported.includes("long-animation-frame")) {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        loaf.n++; loaf.ms += e.duration; loaf.blocking += e.blockingDuration ?? 0;
        const scripts = (e.scripts ?? []).filter((s) => s.duration >= 20).map((s) => ({
          origin: originsFromStack(s.sourceURL)[0] ?? (s.sourceURL ? new URL(s.sourceURL, location.href).pathname.split("/").slice(0, 3).join("/") : "?"),
          invoker: String(s.invoker ?? "").slice(0, 80), type: s.invokerType, ms: Math.round(s.duration), fn: String(s.sourceFunctionName ?? "").slice(0, 60),
        }));
        for (const s of scripts) loaf.origins[s.origin] = (loaf.origins[s.origin] ?? 0) + s.ms;
        recentLoaf.push({ end: e.startTime + e.duration, scripts });
        if (recentLoaf.length > 20) recentLoaf.shift();
        if (e.duration >= LOAF_DETAIL_MS) rec.emit("perf.loaf", { ms: Math.round(e.duration), blocking: Math.round(e.blockingDuration ?? 0), scripts: scripts.slice(0, 8) });
      }
    }).observe({ type: "long-animation-frame" });
  }

  setInterval(() => {
    try {
      const sorted = frames.slice().sort((a, b) => a - b);
      const sum = frames.reduce((a, b) => a + b, 0);
      if (hiddenAt != null) { hiddenMs += performance.now() - hiddenAt; hiddenAt = performance.now(); }
      const mem = performance.memory;
      const topOrigins = Object.entries(loaf.origins).sort((a, b) => b[1] - a[1]).slice(0, 8);
      rec.emit("perf.window", {
        windowMs: WINDOW_MS, frames: frames.length, fps: sum ? round((frames.length * 1000) / sum) : null,
        p50: round(pct(sorted, 50)), p95: round(pct(sorted, 95)), p99: round(pct(sorted, 99)), max: round(sorted.at(-1)),
        over50: frames.filter((f) => f > 50).length, over100: frames.filter((f) => f > 100).length,
        longTasks: { n: longTasks.n, ms: Math.round(longTasks.ms) },
        loaf: { n: loaf.n, ms: Math.round(loaf.ms), blocking: Math.round(loaf.blocking), topOrigins: Object.fromEntries(topOrigins) },
        heapMb: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null,
        hiddenMs: Math.round(hiddenMs),
        latencyMs: game.time?.averageLatency ?? null, // Foundry's one-way estimate from its periodic time sync
        hooks: Object.fromEntries(Object.entries(hookCounts).filter(([, v]) => v)),
        canvas: globalThis.canvas?.ready ? { fpsTarget: canvas.app?.ticker?.maxFPS ?? null, tokens: canvas.tokens?.placeables?.length ?? null, zoom: round(canvas.stage?.scale?.x) } : null,
      });
    } catch { rec.counters.selfErrors++; }
    frames = []; longTasks = { n: 0, ms: 0 }; loaf = { n: 0, ms: 0, blocking: 0, origins: {} }; hiddenMs = 0;
    hookCounts = Object.fromEntries(COUNTED_HOOKS.map((h) => [h, 0]));
  }, WINDOW_MS);

  return { supports: { longtask: supported.includes("longtask"), loaf: supported.includes("long-animation-frame"), memory: !!performance.memory } };
}
