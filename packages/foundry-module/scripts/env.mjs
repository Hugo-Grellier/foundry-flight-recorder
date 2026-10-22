// Environment/configuration snapshot with fingerprints for cross-session comparison.
// Settings filter (robust, generic): only Boolean/Number settings, or String settings with enumerated
// `choices`; never free text, objects, or keys that look like credentials/URLs. Values are toggles,
// not content.
import { stableStringify } from "./schema.mjs";
import { hash, state } from "./util.mjs";
import { RECORDER_VERSION } from "./recorder.mjs";

const SECRET_KEY = /key|token|secret|passw|auth|api|webhook|url|uri|email|license|credential|host|server|endpoint/i;

export function safeSettings() {
  const active = new Set(["core", game.system?.id, ...[...game.modules].filter((m) => m.active).map((m) => m.id)]);
  const out = {};
  for (const [id, s] of game.settings.settings) {
    if (!active.has(s.namespace) || SECRET_KEY.test(s.key)) continue;
    const enumerated = s.type === String && s.choices && typeof s.choices === "object";
    if (!(s.type === Boolean || s.type === Number || enumerated)) continue;
    if (s.scope === "user") continue; // user-scoped settings may hold per-player preferences tied to identity
    try {
      const v = game.settings.get(s.namespace, s.key);
      if (["boolean", "number", "string"].includes(typeof v) && String(v).length <= 64) out[id] = v;
    } catch { /* setting unreadable for this user (GM-only world setting) */ }
  }
  return out;
}

function gpu() {
  try {
    const gl = canvas?.app?.renderer?.gl ?? document.createElement("canvas").getContext("webgl2");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    return { renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER) ?? null, webgl2: typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext };
  } catch { return null; }
}

const chunks = (obj, size = 90) => {
  const entries = Object.entries(obj);
  const out = [];
  for (let i = 0; i < entries.length; i += size) out.push(Object.fromEntries(entries.slice(i, i + size)));
  return out;
};

/** Emit env.snapshot + env.modules[] + env.settings[]. Returns fingerprints. */
export function emitEnvironment(rec, { mode, perfSupports, adapters }) {
  const modules = Object.fromEntries([...game.modules].filter((m) => m.active).map((m) => [m.id, m.version ?? "?"]).sort());
  const settings = safeSettings();
  const fp = {
    modules: hash(stableStringify(modules)), settings: hash(stableStringify(settings)),
    core: hash(`${game.release?.version}|${game.system?.id}@${game.system?.version}`),
  };
  fp.all = hash(`${fp.core}|${fp.modules}|${fp.settings}`);
  const nav = globalThis.navigator ?? {};
  rec.emit("env.snapshot", {
    foundry: { version: game.release?.version ?? game.version, generation: game.release?.generation, build: game.release?.build },
    system: { id: game.system?.id, version: game.system?.version },
    world: { id: game.world?.id, title: state.includeNames ? game.world?.title : undefined },
    nModules: Object.keys(modules).length, nSettings: Object.keys(settings).length, fp,
    browser: {
      ua: nav.userAgent, brands: nav.userAgentData?.brands?.map((b) => `${b.brand} ${b.version}`) ?? null, platform: nav.userAgentData?.platform ?? nav.platform,
      mobile: nav.userAgentData?.mobile ?? null, cores: nav.hardwareConcurrency ?? null, memGb: nav.deviceMemory ?? null, lang: nav.language,
      dpr: globalThis.devicePixelRatio, screen: { w: screen.width, h: screen.height }, viewport: { w: innerWidth, h: innerHeight },
      secure: globalThis.isSecureContext,
    },
    gpu: gpu(), perfSupports,
    recorder: { version: RECORDER_VERSION, mode, adapters },
  }, { local: true });
  for (const c of chunks(modules)) rec.emit("env.modules", { modules: c }, { local: true });
  for (const c of chunks(settings)) rec.emit("env.settings", { settings: c }, { local: true });
  return fp;
}
