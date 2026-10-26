// Storage: each event batch becomes one JSON file on the Foundry server, under the user data root
// (Data/flight-recorder/<world>/<session>/<participant>/<client>-<seq>.json). Not inside the module folder:
// some installs mount Data/modules read-only, and module updates never touch this folder.
// A client whose user may upload files (Foundry permission FILES_UPLOAD) writes its own batches, so it
// records with or without a GM online; any other client relays its batches to the active GM over the
// module socket (recipients: that GM only) and retries until a GM acknowledges the write.
// Foundry specifics are injected so this file is unit-tested under Node.
import { validateBatch, LIMITS } from "./schema.mjs";

export const STORAGE_ROOT = "flight-recorder";

// No dots: a path segment can never be "." or ".." (relayed batches are written by the GM).
const safe = (s) => String(s ?? "_").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "_";

/**
 * File location of a batch: one folder per participant, so a relayed batch can only ever land in its
 * sender's folder. Non-media files cannot be overwritten, so the name is unique per batch.
 */
export function batchPath(env) {
  const seq = env.events?.[0]?.seq;
  return {
    dir: `${STORAGE_ROOT}/${safe(env.world)}/${safe(env.sessionId)}/${safe(env.user)}`,
    name: `${safe(env.clientId)}-${String(Number.isInteger(seq) && seq >= 0 ? seq : 0).padStart(8, "0")}.json`,
  };
}

export class FoundryStore {
  /**
   * @param {object} o
   * @param {(dir:string, name:string, text:string)=>Promise<{path?:string, error?:string}>} o.upload
   * @param {(path:string)=>Promise<any>} o.mkdir           rejects when the directory exists
   * @param {(msg:object, recipients:string[])=>void} o.emit  module socket emit
   * @param {()=>boolean} o.canUpload                        this user may write files
   * @param {()=>string|null} o.relayTo                      user id of the GM to relay through, if online
   * @param {()=>boolean} o.isRelay                          this client is that GM (and the recorder is enabled)
   * @param {(userId:string)=>string} o.pseudo              pseudonym of a sender (relayed batches cannot impersonate)
   */
  constructor(o) {
    this.o = { timeoutMs: 15000, ...o };
    this.dirs = new Set();
    this.pending = new Map();
    this.relayBudget = new Map(); // sender -> {tokens, at}: a player cannot make the GM write files without bound
  }

  /** Recorder transport: batch JSON -> {ok, status}. */
  send = async (body) => (this.o.canUpload() ? this.write(JSON.parse(body)) : this.relay(body));

  async write(env) {
    const { dir, name } = batchPath(env);
    try {
      if (!this.dirs.has(dir)) {
        const parts = dir.split("/");
        for (let i = STORAGE_ROOT.split("/").length; i <= parts.length; i++) await this.o.mkdir(parts.slice(0, i).join("/")).catch(() => {}); // exists
        this.dirs.add(dir);
      }
      const r = await this.o.upload(dir, name, JSON.stringify(env));
      if (r?.path) return { ok: true, status: 200 };
      const err = String(r?.error ?? "");
      if (/overwrite/i.test(err)) return { ok: true, status: 200 }; // a timed-out earlier attempt already stored it
      if (/does not exist/i.test(err)) this.dirs.delete(dir); // deleted meanwhile: recreate on retry
      return { ok: false, status: /permission/i.test(err) ? 403 : 500 };
    } catch {
      return { ok: false, status: 0 };
    }
  }

  relay(body) {
    const gm = this.o.relayTo();
    if (!gm) return { ok: false, status: 0 }; // no GM online: the recorder keeps the batch and retries
    const id = Math.random().toString(36).slice(2, 12);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, status: 0 }); }, this.o.timeoutMs);
      this.pending.set(id, (res) => { clearTimeout(timer); this.pending.delete(id); resolve(res); });
      this.o.emit({ t: "batch", id, body }, [gm]);
    });
  }

  /** Module socket handler: (message, sender user id). */
  async handle(msg, from) {
    if (msg?.t === "ack") return this.pending.get(msg.id)?.({ ok: !!msg.ok, status: msg.status ?? 0 });
    if (msg?.t !== "batch" || !this.o.isRelay()) return;
    const now = Date.now();
    const b = this.relayBudget.get(from) ?? { tokens: 30, at: now };
    b.tokens = Math.min(30, b.tokens + (now - b.at) / 1000); b.at = now; // 1 batch/s, burst 30
    this.relayBudget.set(from, b);
    let res;
    if (b.tokens < 1) res = { ok: false, status: 429 };
    else try {
      b.tokens--;
      if (typeof msg.body !== "string" || msg.body.length > LIMITS.batchBytes) throw new Error("size");
      const env = JSON.parse(msg.body);
      if (env && typeof env === "object") env.user = this.o.pseudo(from); // identity = authenticated socket sender
      const v = validateBatch(env);
      if (!v.ok) throw new Error("schema");
      // event ids must belong to the batch's client (ids are the dedup key on import)
      const events = v.batch.events.filter((e) => e.id === `${v.batch.clientId}.${e.seq}`);
      res = events.length ? await this.write({ ...v.batch, events }) : { ok: true, status: 200 };
    } catch { res = { ok: false, status: 400 }; }
    this.o.emit({ t: "ack", id: msg.id, ...res }, [from]);
  }
}
