// Collector-less storage: each event batch becomes one JSON file in the module's persistent storage on the
// Foundry server (Data/modules/foundry-flight-recorder/storage/<world>/<session>/<client>-<seq>.json).
// A client whose user may upload files (Foundry permission FILES_UPLOAD) writes its own batches, so it
// records with or without a GM online; any other client relays its batches to the active GM over the
// module socket (recipients: that GM only) and retries until a GM acknowledges the write.
// Foundry specifics are injected so this file is unit-tested under Node.

export const STORAGE_ROOT = "modules/foundry-flight-recorder/storage";
export const FOUNDRY_ENDPOINT = "foundry:"; // Recorder endpoint value selecting this transport

const safe = (s) => String(s ?? "_").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "_";

/** File location of a batch. Non-media files cannot be overwritten, so the name is unique per batch. */
export function batchPath(env) {
  const seq = String(env.events?.[0]?.seq ?? 0).padStart(8, "0");
  return { dir: `${STORAGE_ROOT}/${safe(env.world)}/${safe(env.sessionId)}`, name: `${safe(env.clientId)}-${seq}.json` };
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
  }

  /** Recorder `fetch` replacement. */
  send = async (url, init) => (this.o.canUpload() ? this.write(JSON.parse(init.body)) : this.relay(init.body));

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
    let res;
    try {
      const env = JSON.parse(msg.body);
      if (!Array.isArray(env?.events) || typeof env.sessionId !== "string") throw new Error("bad batch");
      env.user = this.o.pseudo(from);
      res = await this.write(env);
    } catch { res = { ok: false, status: 400 }; }
    this.o.emit({ t: "ack", id: msg.id, ...res }, [from]);
  }
}
