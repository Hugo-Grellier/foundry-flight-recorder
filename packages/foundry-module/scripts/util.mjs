// Small Foundry-facing helpers shared by capture code and adapters.

// cyrb53: fast non-cryptographic 53-bit hash. Used for pseudonyms and config fingerprints because
// crypto.subtle is unavailable on non-secure origins (plain-HTTP LAN Foundry).
export function hash(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Pseudonymous, stable per world: same user -> same id across sessions; no name. */
export const pseudo = (worldId, userId) => `u_${hash(`${worldId}:${userId}`)}`;

export const state = { includeNames: true, worldId: "" };

/**
 * Compact reference to a document: id/uuid, type, and (if allowed) name.
 * Never copies descriptions or other content.
 */
export function ref(doc) {
  if (!doc) return null;
  try {
    const r = { uuid: doc.uuid ?? undefined, doc: doc.documentName ?? doc.constructor?.documentName ?? undefined };
    if (doc.type && typeof doc.type === "string") r.type = doc.type;
    const slug = doc.slug ?? doc.system?.slug;
    if (typeof slug === "string") r.slug = slug;
    if (state.includeNames && typeof doc.name === "string") r.name = doc.name;
    if (doc.documentName === "Actor") r.pc = !!doc.hasPlayerOwner;
    return r;
  } catch { return null; }
}

export function userRef(user) {
  if (!user) return null;
  return { user: pseudo(state.worldId, user.id), gm: !!user.isGM };
}

export const isActiveGM = () => {
  const gm = game.users?.activeGM;
  return gm ? gm.isSelf : !!game.user?.isGM;
};

export const isSelf = (userId) => userId === game.user?.id;

/** Resolve the Application instance owning a DOM element (V2 then V1). */
export function appFor(el) {
  const root = el?.closest?.(".application, .app, .window-app");
  if (!root) return null;
  const v2 = foundry.applications?.instances?.get?.(root.id);
  if (v2) return v2;
  const appId = root.dataset?.appid;
  return appId ? ui.windows?.[appId] ?? null : null;
}

export const appName = (app) => app?.constructor?.name ?? null;

export function appRef(app) {
  if (!app) return null;
  const r = { cls: appName(app), appId: String(app.id ?? app.appId ?? "") };
  const doc = app.document ?? app.object;
  if (doc?.documentName) r.doc = ref(doc);
  if (state.includeNames && typeof app.title === "string") r.title = app.title.slice(0, 120);
  return r;
}

/** Shallow list of changed key paths (no values), for update hooks. */
export function changedPaths(change, max = 20) {
  const out = [];
  const walk = (o, p) => {
    for (const [k, v] of Object.entries(o ?? {})) {
      if (k === "_id" || k === "_stats") continue;
      const path = p ? `${p}.${k}` : k;
      if (v && typeof v === "object" && !Array.isArray(v) && out.length < max) walk(v, path);
      else if (out.length < max) out.push(path);
    }
  };
  walk(change, "");
  return out;
}

export const combatCtx = () => {
  const c = game.combat;
  if (!c?.started) return undefined;
  return { id: c.id, round: c.round, turn: c.turn };
};
