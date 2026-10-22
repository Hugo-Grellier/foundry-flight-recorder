# Writing an adapter

Adapters translate a system's or module's hooks into semantic events. They live in
`packages/foundry-module/scripts/adapters/` and are listed in `adapters/index.mjs`.

```js
// adapters/my-module.mjs
import { ref, isSelf, isActiveGM } from "../util.mjs";
export default {
  id: "my-module",
  detect: () => !!game.modules.get("my-module")?.active,   // feature detection, never throws
  install({ rec, on }) {                                    // `on` = Hooks.on wrapped in try/catch
    on("myModule.somethingHappened", (doc, userId) => {
      if (!isSelf(userId)) return;                          // record on the initiating client
      rec.emit("mymod.something", { doc: ref(doc) }, { local: true });
    });
  },
};
```

Rules:
- Read-only: never return a value from a hook (would veto `pre*` hooks), never mutate documents.
- Feature-detect every field (`?.`); a data-model change must degrade to missing fields.
- Use `rec.span(kind, data, {type})` for begin/end interactions; `end(outcome)` once.
- Globally observable events: record on the active GM (`isActiveGM()`) with a `dk` dedup key.
- Event type: `<prefix>.<name>`, lowercase; document it in `docs/telemetry-schema.md`. Unknown types are
  accepted by the collector (category = prefix), default level 1 (detailed) unless `lvl` is passed.
- `detect`/`install` failures are reported as `rec.adapter {ok:false}` and do not affect other capture.

Shipped: `pf2e` (checks, actions, turns, rerolls, damage, conditions), `dice-so-nice` (animation spans).
