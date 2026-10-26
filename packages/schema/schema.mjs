// Shared telemetry schema: used verbatim by the Foundry module (browser) and the analysis CLI (Node).
// Plain ES module, no dependencies, no Node/DOM globals.

export const SCHEMA_VERSION = 1;

export const LIMITS = Object.freeze({
  batchEvents: 500,          // events per batch
  batchBytes: 512 * 1024,    // serialized batch body
  eventBytes: 16 * 1024,     // serialized single event
  string: 2000,              // generic string field
  stack: 8000,               // stack traces
  arrayItems: 50,
  depth: 6,
  idLength: 80,
});

// Collection levels: an event is sent when its level <= active mode level.
export const MODES = Object.freeze({ normal: 0, detailed: 1, diagnostic: 2 });

// Severity ladder shared by recorder and CLI.
export const SEVERITIES = ["debug", "info", "notice", "warn", "error", "critical"];

// Known event types -> default category/level. Adapters may emit other types
// matching TYPE_RE; their category is the first dotted segment.
export const EVENT_TYPES = Object.freeze({
  "session.start": { lvl: 0 }, "session.stop": { lvl: 0 },
  "rec.start": { lvl: 0 }, "rec.stop": { lvl: 0 }, "rec.consent": { lvl: 0 }, "rec.mode": { lvl: 0 },
  "rec.loss": { lvl: 0 }, "rec.selferror": { lvl: 0 }, "rec.adapter": { lvl: 0 },
  "client.load": { lvl: 0 }, "client.unload": { lvl: 0 }, "client.visibility": { lvl: 0 }, "client.idle": { lvl: 0 },
  "env.snapshot": { lvl: 0 }, "env.modules": { lvl: 0 }, "env.settings": { lvl: 0 },
  "net.socket": { lvl: 0 }, "net.online": { lvl: 0 }, "user.connection": { lvl: 0 },
  "err.js": { lvl: 0 }, "err.promise": { lvl: 0 }, "err.foundry": { lvl: 0 }, "err.console": { lvl: 0 },
  "warn.console": { lvl: 1 }, "ui.notify": { lvl: 0 },
  "ui.app.open": { lvl: 0 }, "ui.app.close": { lvl: 0 }, "ui.tab": { lvl: 0 }, "ui.action": { lvl: 0 },
  "ui.click": { lvl: 1 }, "ui.focus": { lvl: 1 }, "ui.sidebar": { lvl: 0 }, "ui.layer": { lvl: 1 },
  "token.control": { lvl: 0 }, "token.target": { lvl: 0 }, "token.move": { lvl: 0 },
  "scene.load": { lvl: 0 }, "scene.summary": { lvl: 0 }, "scene.teardown": { lvl: 0 },
  "doc.create": { lvl: 0 }, "doc.update": { lvl: 1 }, "doc.delete": { lvl: 0 },
  "chat.message": { lvl: 0 }, "chat.origin": { lvl: 0 }, "lw.conflict": { lvl: 0 }, "hook.veto": { lvl: 0 }, "rec.profiling": { lvl: 0 },
  "combat.start": { lvl: 0 }, "combat.end": { lvl: 0 }, "combat.round": { lvl: 0 }, "combat.turn": { lvl: 0 },
  "pf2e.turn": { lvl: 0 }, "pf2e.check": { lvl: 0 }, "pf2e.reroll": { lvl: 0 }, "pf2e.damage": { lvl: 0 },
  "pf2e.condition": { lvl: 0 }, "pf2e.action": { lvl: 0 },
  "perf.window": { lvl: 0 }, "perf.stall": { lvl: 0 }, "perf.loaf": { lvl: 1 }, "perf.hooks": { lvl: 2 },
  "friction.mark": { lvl: 0 }, "dsn.roll": { lvl: 1 },
});

export const TYPE_RE = /^[a-z][a-z0-9]*(\.[a-z0-9_-]+){1,3}$/;
const ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;

export const categoryOf = (type) => type.split(".")[0];

// ---------------------------------------------------------------------------
// Sanitization (applied client-side before queueing AND again on import).

// Keys whose values are dropped. "token" alone is NOT here: Foundry tokens are game objects.
const SENSITIVE_KEY = /passw|secret|api[-_]?key|access[-_]?key|private[-_]?key|auth(oriz|entic)|cookie|bearer|credential|licen[cs]e|^key$|^content$|^html$|^text$|^body$/i;
// Values we scrub inside any string.
const SCRUBBERS = [
  [/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, "[jwt]"],
  [/\bBearer\s+[\w.~+/=-]+/gi, "Bearer [redacted]"],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]"],
  [/([?&](?:key|token|auth|sig|signature|password|session|code)=)[^&#\s"']+/gi, "$1[redacted]"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]"],
];

export function scrubString(s, max = LIMITS.string) {
  let out = String(s);
  if (out.length > max * 2) out = out.slice(0, max * 2);
  for (const [re, rep] of SCRUBBERS) out = out.replace(re, rep);
  return out.length > max ? out.slice(0, max) + "…" : out;
}

/**
 * Deep-copy `value` keeping only JSON-safe, bounded, scrubbed data.
 */
export function sanitize(value, { depth = 0, key = "" } = {}) {
  if (value === null || value === undefined) return value ?? null;
  const t = typeof value;
  if (t === "number") return Number.isFinite(value) ? value : null;
  if (t === "boolean") return value;
  if (t === "string") return scrubString(value, key === "stack" ? LIMITS.stack : LIMITS.string);
  if (t !== "object") return null; // functions, symbols, bigint
  if (depth >= LIMITS.depth) return "[depth]";
  if (Array.isArray(value)) {
    const out = value.slice(0, LIMITS.arrayItems).map((v) => sanitize(v, { depth: depth + 1, key }));
    if (value.length > LIMITS.arrayItems) out.push(`[+${value.length - LIMITS.arrayItems}]`);
    return out;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return `[${value.constructor?.name ?? "object"}]`;
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(value)) {
    if (++n > 100) { out["…"] = "[truncated]"; break; }
    if (SENSITIVE_KEY.test(k) || k === "__proto__" || k === "constructor" || k === "prototype") continue;
    const s = sanitize(v, { depth: depth + 1, key: k });
    if (s !== undefined) out[k] = s;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validation. Returns { ok, errors, batch } where batch.events contains only valid events.

const isStr = (v, max = LIMITS.string) => typeof v === "string" && v.length > 0 && v.length <= max;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const optStr = (v, max) => v === undefined || v === null || isStr(v, max);
const optNum = (v) => v === undefined || v === null || isNum(v);

export function validateEvent(e) {
  const errs = [];
  if (!e || typeof e !== "object" || Array.isArray(e)) return ["event not an object"];
  if (!isStr(e.id, LIMITS.idLength) || !ID_RE.test(e.id)) errs.push("id");
  if (!Number.isInteger(e.seq) || e.seq < 0) errs.push("seq");
  if (!isStr(e.type, 64) || !TYPE_RE.test(e.type)) errs.push("type");
  if (!isNum(e.t) || e.t < 1e12 || e.t > 1e13) errs.push("t");
  if (!optNum(e.mono)) errs.push("mono");
  if (e.sev !== undefined && !SEVERITIES.includes(e.sev)) errs.push("sev");
  for (const k of ["scene", "corr", "parent", "dk", "src", "mode", "sample"]) if (!optStr(e[k], 200)) errs.push(k);
  if (e.combat !== undefined && e.combat !== null) {
    const c = e.combat;
    if (typeof c !== "object" || !optStr(c.id, 80) || !optNum(c.round) || !optNum(c.turn)) errs.push("combat");
  }
  if (e.span !== undefined && e.span !== null) {
    const s = e.span;
    if (typeof s !== "object" || !isStr(s.id, LIMITS.idLength) || !["b", "e", "i"].includes(s.ph)
      || !optStr(s.out, 32) || !optStr(s.kind, 64)) errs.push("span");
  }
  if (e.local !== undefined && typeof e.local !== "boolean") errs.push("local");
  if (e.data !== undefined && (e.data === null || typeof e.data !== "object" || Array.isArray(e.data))) errs.push("data");
  if (!errs.length && JSON.stringify(e).length > LIMITS.eventBytes) errs.push("size");
  return errs;
}

export function validateBatch(b) {
  const errors = [];
  if (!b || typeof b !== "object") return { ok: false, errors: ["batch not an object"] };
  if (b.v !== SCHEMA_VERSION) errors.push(`unsupported schema version ${b.v}`);
  if (!isStr(b.sessionId, 80) || !ID_RE.test(b.sessionId)) errors.push("sessionId");
  if (!isStr(b.clientId, 80) || !ID_RE.test(b.clientId)) errors.push("clientId");
  if (!isStr(b.user, 80) || !ID_RE.test(b.user)) errors.push("user");
  if (!optStr(b.role, 16)) errors.push("role");
  if (!optStr(b.world, 80)) errors.push("world");
  if (!isNum(b.sentAt)) errors.push("sentAt");
  if (!Number.isInteger(b.batchSeq) || b.batchSeq < 0) errors.push("batchSeq");
  if (!Array.isArray(b.events)) errors.push("events");
  else if (b.events.length > LIMITS.batchEvents) errors.push("too many events");
  if (b.dropped !== undefined && (!Number.isInteger(b.dropped) || b.dropped < 0)) errors.push("dropped");
  if (errors.length) return { ok: false, errors };
  const events = [];
  const rejected = [];
  for (const e of b.events) {
    const errs = validateEvent(e);
    if (errs.length) rejected.push({ id: typeof e?.id === "string" ? e.id.slice(0, 80) : null, errors: errs });
    else events.push(e);
  }
  return { ok: true, errors, rejected, batch: { ...b, events } };
}

// Stable stringify for fingerprints (sorted keys).
export function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
}

// Module/system attribution from a stack trace or script URL.
const PKG_RE = /\/(modules|systems)\/([A-Za-z0-9_.-]+)\//g;
export function originsFromStack(stack) {
  const out = [];
  if (!stack) return out;
  for (const m of String(stack).matchAll(PKG_RE)) {
    const id = `${m[1] === "systems" ? "system:" : ""}${m[2]}`;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Package of the top stack frame (the throw site), or null when that frame is not module/system code.
 * Lower frames often belong to wrappers (libWrapper, timer/hook patches) and are only "involved".
 */
export function topOrigin(stack) {
  const frame = String(stack ?? "").split("\n").find((l) => /^\s*at\s|@/.test(l));
  return frame ? originsFromStack(frame)[0] ?? null : null;
}

// Error fingerprint: message with volatile parts (ids, numbers, quoted names) normalized.
export function errorFingerprint(message, origin = "") {
  const norm = String(message ?? "")
    .replace(/\b[A-Za-z0-9]{16}\b/g, "<id>")
    .replace(/\d+(\.\d+)?/g, "<n>")
    .replace(/(["'`]).*?\1/g, "<s>")
    .slice(0, 200);
  return `${origin || "?"}|${norm}`;
}
