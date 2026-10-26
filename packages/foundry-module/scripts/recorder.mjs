// Recorder core: event construction, mode filtering, pre-error ring buffer, rate limiting,
// bounded queue, batching, retry with backoff, crash persistence. No Foundry globals here:
// everything environment-specific is injected, so this file is unit-tested under Node.
import { SCHEMA_VERSION, EVENT_TYPES, MODES, sanitize, LIMITS } from "./schema.mjs";

export const RECORDER_VERSION = "0.2.0";

const DEFAULTS = {
  flushMs: 5000,
  batchEvents: 200,
  batchBytes: 400 * 1024,
  maxQueue: 5000,
  ringSize: 300,
  typeRate: 20, typeBurst: 60,      // events/s per type
  globalRate: 150, globalBurst: 400, // events/s overall
  backoffMinMs: 1000, backoffMaxMs: 60000,
  escalateMs: 60000,                 // diagnostic window after error/stall/friction
  escalateCooldownMs: 30000,
  persistBytes: 1024 * 1024,
  beaconBytes: 60 * 1024,
  fetchTimeoutMs: 15000,
};

// Event types whose occurrence promotes the ring buffer and escalates to diagnostic mode.
const TRIGGERS = new Set(["err.js", "err.promise", "err.foundry", "err.console", "perf.stall", "friction.mark"]);
// Never sampled out: triggers and lifecycle/bookkeeping events the analysis depends on.
const UNSAMPLED = new Set([...TRIGGERS, "session.start", "session.stop", "rec.start", "rec.stop", "rec.mode", "rec.loss", "rec.adapter", "env.snapshot", "env.modules", "env.settings", "client.load", "client.unload"]);

class Bucket {
  constructor(rate, burst) { this.rate = rate; this.burst = burst; this.tokens = burst; this.at = 0; }
  take(now) {
    // clamp: wall clocks can jump backwards (NTP); never let that drain the bucket
    this.tokens = Math.min(this.burst, this.tokens + (Math.max(0, now - this.at) / 1000) * this.rate);
    this.at = Math.max(this.at, now);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

const rid = (n = 10) => Array.from({ length: n }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");

export class Recorder {
  /**
   * @param {object} o
   * @param {(url:string, init:object)=>Promise<{ok:boolean,status:number}>} o.fetch
   * @param {{getItem:Function,setItem:Function,removeItem:Function}} [o.storage]  crash persistence (localStorage)
   * @param {(url:string, body:string)=>boolean} [o.beacon]  navigator.sendBeacon wrapper
   * @param {()=>object} [o.context]   per-event context provider ({scene, combat})
   * @param {()=>number} [o.now] @param {()=>number} [o.mono]
   * @param {(fn:Function, ms:number)=>any} [o.setTimer] @param {(h:any)=>void} [o.clearTimer]
   */
  constructor(o = {}) {
    this.o = { ...DEFAULTS, ...o };
    this.now = o.now ?? (() => Date.now());
    this.mono = o.mono ?? (() => (globalThis.performance ? Math.round(performance.now() * 10) / 10 : 0));
    this.setTimer = o.setTimer ?? ((f, ms) => setTimeout(f, ms));
    this.clearTimer = o.clearTimer ?? ((h) => clearTimeout(h));
    this.clientId = o.clientId ?? `c${rid(10)}`;
    this.state = "pending"; // pending: queue locally, send nothing | active: send | off: drop everything
    this.ident = { sessionId: null, user: null, role: null, world: null };
    this.endpoint = o.endpoint ?? null;
    this.key = o.key ?? "";
    this.mode = o.mode ?? "normal";
    this.baseMode = this.mode;
    this.escalatedUntil = 0;
    this.lastEscalation = -Infinity;
    this.seq = 0;
    this.batchSeq = 0;
    this.queue = [];   // wrappers {sid, e}
    this.ring = [];    // wrappers {e, queued}
    this.typeBuckets = new Map();
    this.globalBucket = new Bucket(this.o.globalRate, this.o.globalBurst);
    this.counters = { emitted: 0, sent: 0, dropped: 0, droppedUnreported: 0, sampledOut: {}, rejected: 0, failures: 0, selfErrors: 0 };
    this.inFlight = false;
    this.flushing = null;
    this.backoff = 0;
    this.timer = null;
    this.emitting = false;
    this.lastStatus = { ok: null, status: null, at: null };
    this.spans = new Map();
  }

  get modeLevel() { return MODES[this.effectiveMode()] ?? 0; }
  effectiveMode() { return this.now() < this.escalatedUntil ? "diagnostic" : this.mode; }

  configure({ endpoint, key, mode, sessionId, user, role, world, flushMs } = {}) {
    if (endpoint !== undefined) this.endpoint = endpoint;
    if (flushMs !== undefined) this.o.flushMs = flushMs;
    if (key !== undefined) this.key = key;
    if (mode !== undefined && mode in MODES) { this.mode = mode; this.baseMode = mode; }
    if (sessionId !== undefined) this.ident.sessionId = sessionId;
    if (user !== undefined) this.ident.user = user;
    if (role !== undefined) this.ident.role = role;
    if (world !== undefined) this.ident.world = world;
  }

  activate() {
    if (!this.endpoint || !this.ident.sessionId || !this.ident.user) throw new Error("recorder: endpoint/session/user missing");
    this.state = "active";
    for (const w of this.queue) w.sid ??= this.ident.sessionId; // pre-activation events belong to this session
    this.#schedule(0);
  }

  /**
   * Stop sending; drop everything not yet sent (opt-out, consent refusal, no session).
   * The next activation is a new client instance (new id, seq from 0), so dropped pre-session
   * events never show up as sequence gaps and ids never collide with already-stored ones.
   */
  disable() {
    this.state = "off";
    this.queue = []; this.ring = []; this.spans.clear();
    this.escalatedUntil = 0; this.lastEscalation = -Infinity; // its rec.mode was just dropped: do not leak the escalation
    if (this.seq > 0) { this.clientId = `c${rid(10)}`; this.seq = 0; this.batchSeq = 0; }
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  /**
   * End of a recording period (session stopped, recorder disabled by the GM): try to send everything;
   * whatever could not be delivered is persisted and re-sent (same ids, same session) on the next
   * activation, so the session's last events (e.g. session.stop) survive a collector hiccup.
   */
  async close() {
    if (this.state === "active") {
      await this.flush();
      if (this.queue.length) {
        const rest = [];
        while (this.queue.length) { const { sid, events } = this.#takeBatch(); if (!events.length) break; rest.push({ sid, clientId: this.clientId, user: this.ident.user, events }); }
        this.persist([...this.#stored(), ...rest]);
      }
    }
    this.disable();
  }

  #stored() {
    try { return JSON.parse(this.o.storage?.getItem(this.o.storageKey ?? "ffr.pending") ?? "[]"); } catch { return []; }
  }

  /**
   * Record an event. Returns the event (or null when filtered/dropped).
   * opts: sev, lvl, local, dk, corr, parent, span, src, scene, combat
   */
  emit(type, data = {}, opts = {}) {
    if (this.state === "off" || this.emitting) return null;
    this.emitting = true;
    try {
      const t = this.now();
      const lvl = opts.lvl ?? EVENT_TYPES[type]?.lvl ?? 1;
      const send = lvl <= this.modeLevel;
      // high-volume protection on what will be sent: per-type and global token buckets.
      // Ring-only events skip the buckets (the ring is bounded anyway) so they cannot starve sent ones.
      if (send && !UNSAMPLED.has(type)) {
        let b = this.typeBuckets.get(type);
        if (!b) this.typeBuckets.set(type, (b = new Bucket(this.o.typeRate, this.o.typeBurst)));
        if (!b.take(t) || !this.globalBucket.take(t)) {
          this.counters.sampledOut[type] = (this.counters.sampledOut[type] ?? 0) + 1;
          return null;
        }
      }
      const ctx = opts.noContext ? {} : (this.o.context?.() ?? {});
      const e = { id: "", seq: -1, type, t, mono: this.mono() };
      if (opts.sev) e.sev = opts.sev;
      const scene = opts.scene ?? ctx.scene;
      if (scene) e.scene = scene;
      const combat = opts.combat ?? ctx.combat;
      if (combat) e.combat = combat;
      for (const k of ["corr", "parent", "dk", "src", "sample"]) if (opts[k]) e[k] = String(opts[k]).slice(0, 200);
      if (opts.local !== undefined) e.local = !!opts.local;
      if (opts.span) e.span = opts.span;
      e.mode = this.effectiveMode();
      e.data = sanitize(data ?? {});
      if (JSON.stringify(e).length > LIMITS.eventBytes - 200) e.data = { truncated: true, keys: Object.keys(e.data).slice(0, 30) };
      this.counters.emitted++;

      const w = { e, queued: false };
      this.ring.push(w);
      if (this.ring.length > this.o.ringSize) this.ring.shift();
      if (send) this.#enqueue(w);
      if (TRIGGERS.has(type)) this.#trigger(type);
      return e;
    } catch (err) {
      this.counters.selfErrors++;
      return null;
    } finally {
      this.emitting = false;
    }
  }

  /** Interaction span: begin now, end later with an outcome. */
  span(kind, data = {}, opts = {}) {
    const id = opts.id ?? `${kind}.${this.clientId}.${rid(6)}`;
    const type = opts.type ?? kind;
    const begun = this.emit(type, data, { ...opts, span: { id, ph: "b", kind } });
    const t0 = this.now();
    const handle = {
      id, kind, t0,
      end: (out = "ok", more = {}, endOpts = {}) => {
        if (!this.spans.has(id)) return null;
        this.spans.delete(id);
        return this.emit(endOpts.type ?? type, { ...more, dur: this.now() - t0 }, { ...opts, ...endOpts, span: { id, ph: "e", kind, out }, parent: begun?.id ?? opts.parent });
      },
    };
    this.spans.set(id, handle);
    return handle;
  }

  #enqueue(w) {
    if (w.queued) return;
    w.queued = true;
    w.e.seq = this.seq++;
    w.e.id = `${this.clientId}.${w.e.seq}`;
    this.queue.push({ sid: this.state === "active" ? this.ident.sessionId : null, e: w.e });
    if (this.queue.length > this.o.maxQueue) {
      const n = this.queue.length - this.o.maxQueue;
      this.queue.splice(0, n);
      this.counters.dropped += n;
      this.counters.droppedUnreported += n;
    }
    if (this.queue.length >= this.o.batchEvents) this.#schedule(0);
    else this.#schedule(this.o.flushMs);
  }

  // Error/stall/friction: keep the preceding context (events filtered out by the current mode)
  // and temporarily raise the collection level.
  #trigger(type) {
    let promoted = 0;
    for (const w of this.ring) if (!w.queued) { w.e.sample = "context"; this.#enqueue(w); promoted++; }
    const t = this.now();
    if (t - this.lastEscalation > this.o.escalateCooldownMs) {
      this.lastEscalation = t;
      this.escalatedUntil = t + this.o.escalateMs;
      this.emitting = false;
      this.emit("rec.mode", { mode: "diagnostic", reason: type, untilMs: this.o.escalateMs, promoted }, { noContext: true });
      this.emitting = true;
    }
    this.#schedule(1000);
  }

  #schedule(ms) {
    if (this.state !== "active") return;
    if (this.timer) {
      if (ms >= this.o.flushMs) return; // already scheduled sooner or equal
      this.clearTimer(this.timer);
    }
    this.timer = this.setTimer(() => { this.timer = null; this.flush(); }, Math.max(ms, this.backoff));
  }

  #takeBatch() {
    const sid = this.queue[0]?.sid ?? this.ident.sessionId;
    const events = [];
    let bytes = 300;
    while (this.queue.length && events.length < this.o.batchEvents && (this.queue[0].sid ?? sid) === sid) {
      const size = JSON.stringify(this.queue[0].e).length + 1;
      if (events.length && bytes + size > this.o.batchBytes) break;
      bytes += size;
      events.push(this.queue.shift().e);
    }
    return { sid, events };
  }

  #envelope(sid, events, clientId = this.clientId, user = this.ident.user) {
    const dropped = this.counters.droppedUnreported;
    return {
      v: SCHEMA_VERSION, key: this.key, sessionId: sid, clientId, user, role: this.ident.role ?? undefined,
      world: this.ident.world ?? undefined, sentAt: this.now(), batchSeq: this.batchSeq++, dropped, events,
    };
  }

  /**
   * Send queued events. Resolves when the queue is empty or a send failed. Concurrent callers wait
   * for the send in flight and then send what remains (so "emit; await flush(); disable()" never loses).
   */
  async flush() {
    while (this.flushing) await this.flushing;
    if (this.state !== "active" || !this.queue.length) return;
    this.flushing = this.#flushLoop().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  async #flushLoop() {
    this.inFlight = true;
    try {
      this.#reportSampling();
      while (this.queue.length && this.state === "active") {
        const { sid, events } = this.#takeBatch();
        if (!events.length) break;
        const env = this.#envelope(sid, events);
        let res;
        try {
          res = await this.o.fetch(this.endpoint, {
            method: "POST", body: JSON.stringify(env), headers: { "Content-Type": "text/plain" },
            keepalive: JSON.stringify(env).length < this.o.beaconBytes, mode: "cors", credentials: "omit",
            signal: globalThis.AbortSignal?.timeout?.(this.o.fetchTimeoutMs),
          });
        } catch (err) { res = { ok: false, status: 0 }; }
        this.lastStatus = { ok: res.ok, status: res.status, at: this.now() };
        if (res.ok) {
          this.counters.sent += events.length;
          this.counters.droppedUnreported = Math.max(0, this.counters.droppedUnreported - env.dropped);
          this.backoff = 0;
          continue;
        }
        const retryable = res.status === 0 || res.status === 408 || res.status === 429 || res.status >= 500;
        if (retryable) {
          // put back in front, preserving order; backoff with jitter
          this.queue.unshift(...events.map((e) => ({ sid, e })));
          this.counters.failures++;
          this.backoff = Math.min(this.o.backoffMaxMs, Math.max(this.o.backoffMinMs, this.backoff * 2)) * (0.75 + Math.random() * 0.5);
          if (this.queue.length > this.o.maxQueue) {
            const n = this.queue.length - this.o.maxQueue;
            this.queue.splice(0, n);
            this.counters.dropped += n; this.counters.droppedUnreported += n;
          }
          break;
        }
        // 4xx: the collector refused the batch for good (bad key, schema). Never retry: avoids loops.
        this.counters.rejected += events.length;
      }
    } finally {
      this.inFlight = false;
      if (this.queue.length) this.#schedule(this.backoff || this.o.flushMs);
    }
  }

  #reportSampling() {
    const s = this.counters.sampledOut;
    if (!Object.keys(s).length && !this.counters.droppedUnreported) return;
    this.counters.sampledOut = {};
    this.emit("rec.loss", { sampledOut: s, dropped: this.counters.droppedUnreported, totalDropped: this.counters.dropped }, { noContext: true, sev: "notice" });
  }

  /**
   * Page is going away: best-effort sendBeacon of small batches, persist the rest for the next load.
   */
  unload() {
    if (this.state !== "active") return;
    const rest = [];
    while (this.queue.length) {
      const { sid, events } = this.#takeBatch();
      if (!events.length) break;
      const env = this.#envelope(sid, events);
      const body = JSON.stringify(env);
      const ok = body.length < this.o.beaconBytes && this.o.beacon?.(this.endpoint, body);
      // Persist even beaconed batches: beacon delivery is not confirmed, the collector dedups by id.
      rest.push({ sid, clientId: this.clientId, user: this.ident.user, events, beaconed: !!ok });
    }
    this.persist([...this.#stored(), ...rest]);
  }

  persist(batches) {
    if (!this.o.storage || !batches.length) return;
    try {
      let json = JSON.stringify(batches);
      while (json.length > this.o.persistBytes && batches.length) {
        batches.shift(); // keep the newest
        json = JSON.stringify(batches);
      }
      this.o.storage.setItem(this.o.storageKey ?? "ffr.pending", json);
    } catch { /* quota: nothing we can do */ }
  }

  /** Re-send batches persisted by a previous page load (original client ids preserved). */
  async restore() {
    if (!this.o.storage || this.state !== "active") return 0;
    const k = this.o.storageKey ?? "ffr.pending";
    let batches;
    try { batches = JSON.parse(this.o.storage.getItem(k) ?? "[]"); } catch { batches = []; }
    this.o.storage.removeItem(k);
    let n = 0;
    for (const b of batches) {
      if (!b?.events?.length || !b.sid) continue;
      const env = this.#envelope(b.sid, b.events, b.clientId, b.user);
      env.dropped = 0;
      env.restored = true;
      try {
        const res = await this.o.fetch(this.endpoint, { method: "POST", body: JSON.stringify(env), headers: { "Content-Type": "text/plain" }, mode: "cors", credentials: "omit" });
        if (res.ok) n += b.events.length;
      } catch { /* lost: reported as a sequence gap on the collector */ }
    }
    return n;
  }

  /** Last N ring events (for friction-marker context). */
  recent(n = 10) { return this.ring.slice(-n).map((w) => w.e.type); }

  status() {
    return {
      state: this.state, mode: this.mode, effectiveMode: this.effectiveMode(), sessionId: this.ident.sessionId,
      queue: this.queue.length, clientId: this.clientId, ...this.counters, sampledOut: { ...this.counters.sampledOut },
      lastStatus: this.lastStatus, backoffMs: Math.round(this.backoff),
    };
  }
}
