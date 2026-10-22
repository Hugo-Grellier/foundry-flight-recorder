// Adapter registry. An adapter is { id, detect(): boolean, install({rec, on}) }.
// A failing detect/install is reported (rec.adapter) and isolated; it never stops the recorder.
// To add one: write adapters/<id>.mjs exporting that shape and list it below (see docs/adapters.md).
import pf2e from "./pf2e.mjs";

const diceSoNice = {
  id: "dice-so-nice",
  detect: () => !!game.modules.get("dice-so-nice")?.active,
  install({ rec, on }) {
    // Hooks documented by Dice So Nice: diceSoNiceRollStart(messageId, context), diceSoNiceRollComplete(messageId)
    const spans = new Map();
    on("diceSoNiceRollStart", (messageId) => spans.set(messageId, rec.span("dsn.roll", { msg: messageId }, { type: "dsn.roll", local: true })));
    on("diceSoNiceRollComplete", (messageId) => { spans.get(messageId)?.end("done"); spans.delete(messageId); });
  },
};

export const ADAPTERS = [pf2e, diceSoNice];

export function installAdapters(rec, safe) {
  const on = (hook, fn) => Hooks.on(hook, safe(fn));
  const report = [];
  for (const a of ADAPTERS) {
    try {
      if (!a.detect()) continue;
      a.install({ rec, on });
      report.push({ id: a.id, ok: true });
    } catch (err) {
      report.push({ id: a.id, ok: false, error: String(err?.message ?? err).slice(0, 200) });
    }
  }
  return report;
}
