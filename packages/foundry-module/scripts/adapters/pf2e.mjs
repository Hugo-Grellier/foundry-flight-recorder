// PF2e semantic adapter. Verified against PF2e 8.6.1 (Foundry 14.369):
//   hooks  pf2e.startTurn(combatant, encounter, userId), pf2e.endTurn(combatant, encounter, userId),
//          pf2e.reroll(oldRoll, newRoll, resource, {keep}), pf2e.damageRoll(roll)
//   chat   flags.pf2e.context {type, outcome, unadjustedOutcome, dc, domains, traits, isReroll, ...}
//          flags.pf2e.origin {uuid, type}
//   items  conditions are Items of type "condition" (slug, system.value.value), effects type "effect".
// Every field access is optional: a PF2e data model change degrades to missing fields, never an error.
import { ref, isSelf, isActiveGM } from "../util.mjs";
import { rollData } from "../capture.mjs";

export default {
  id: "pf2e",
  detect: () => game.system?.id === "pf2e",
  install({ rec, on }) {
    on("createChatMessage", (msg, options, userId) => {
      const local = isSelf(userId);
      if (!local && !isActiveGM()) return;
      const f = msg.flags?.pf2e;
      if (!f) return;
      const ctx = f.context;
      const origin = f.origin;
      let item = null;
      try { item = origin?.uuid ? fromUuidSync(origin.uuid) : null; } catch { /* compendium/unknown */ }
      const actor = msg.speaker?.actor ? game.actors?.get(msg.speaker.actor) : null;
      const common = { msg: msg.id, actor: ref(actor), item: item ? ref(item) : origin ? { uuid: origin.uuid, type: origin.type } : null };
      const opts = { local, dk: `pf2e:${msg.id}` };
      if (ctx?.type) {
        rec.emit("pf2e.check", {
          ...common, ctype: ctx.type, outcome: ctx.outcome ?? null, unadjusted: ctx.unadjustedOutcome ?? null,
          dc: ctx.dc?.value ?? null, dcSlug: ctx.dc?.slug ?? null, statistic: ctx.statistic ?? ctx.domains?.[0] ?? null,
          domains: (ctx.domains ?? []).slice(0, 6), traits: (ctx.traits ?? []).map((t) => t?.name ?? t).slice(0, 10),
          target: ctx.target ? { actor: !!ctx.target.actor, token: !!ctx.target.token } : null,
          isReroll: !!ctx.isReroll, rollMode: ctx.rollMode ?? null, roll: msg.rolls?.[0] ? rollData(msg.rolls[0]) : null,
          substitutions: (ctx.substitutions ?? []).length || undefined,
        }, opts);
      } else if (item && ["action", "feat", "spell", "weapon", "consumable", "melee"].includes(item.type)) {
        // An item card posted without a check: an action/spell/feature being used.
        rec.emit("pf2e.action", {
          ...common, actionType: item.system?.actionType?.value ?? null, actions: item.system?.actions?.value ?? item.system?.time?.value ?? null,
          traits: (item.system?.traits?.value ?? []).slice(0, 10), rank: item.type === "spell" ? (f.casting?.rank ?? item.rank ?? null) : undefined,
        }, opts);
      }
    });

    const turn = (ph) => (combatant, encounter) => {
      if (!isActiveGM()) return;
      rec.emit("pf2e.turn", { ph, combatant: combatant?.id, actor: ref(combatant?.actor), round: encounter?.round ?? null, pc: !!combatant?.hasPlayerOwner },
        { dk: `pf2eturn:${encounter?.id}:${encounter?.round}:${combatant?.id}:${ph}` });
    };
    on("pf2e.startTurn", turn("start"));
    on("pf2e.endTurn", turn("end"));

    on("pf2e.reroll", (oldRoll, newRoll, resource, opts) => {
      rec.emit("pf2e.reroll", { resource: resource?.slug ?? resource?.name ?? null, keep: opts?.keep ?? null, old: oldRoll?.total ?? null, new: newRoll?.total ?? null }, { local: true });
    });
    on("pf2e.damageRoll", (roll) => rec.emit("pf2e.damage", { roll: rollData(roll), kind: roll?.kind ?? null }, { local: true, lvl: 1 }));

    const condition = (op) => (item, a, b, userId) => {
      // create/delete: (item, options, userId); update: (item, change, options, userId)
      const uid = op === "update" ? userId : b;
      if (!isSelf(uid) || !["condition", "effect"].includes(item?.type)) return;
      rec.emit("pf2e.condition", { op, item: ref(item), actor: ref(item.actor), value: item.system?.value?.value ?? null, badge: item.system?.badge?.value ?? null }, { local: true });
    };
    on("createItem", condition("create"));
    on("updateItem", condition("update"));
    on("deleteItem", condition("delete"));
  },
};
