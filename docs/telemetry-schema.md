# Telemetry schema (v1)

Source of truth: [`packages/schema/schema.mjs`](../packages/schema/schema.mjs) (shared verbatim by the
Foundry module and the analysis CLI). This page explains it.

## Batch envelope (one file `Data/flight-recorder/<world>/<session>/<user>/<client>-<seq>.json`)

| Field | Type | Notes |
|---|---|---|
| `v` | 1 | schema version; other values are refused on import |
| `sessionId` | id | GM-started session (`YYYYMMDD-HHMM-xxxx`) |
| `clientId` | id | one per page load (`c` + 10 chars); a reload is a new client instance |
| `user` | id | pseudonym `u_<hash(worldId:userId)>`, stable per world, no name |
| `role` | `gm`/`player` | |
| `world` | id | world id |
| `sentAt` | epoch ms | client clock at send; used for skew estimation |
| `batchSeq` | int | per client instance |
| `dropped` | int | events dropped locally (queue overflow) not yet reported |
| `restored` | bool | batch persisted at unload and re-sent by the next page load |
| `events` | Event[] | ≤ 500, body ≤ 512 KiB |

Written by the client itself (Foundry permission *Upload Files*) or, for other players, by the active GM's
client after a module-socket relay (the GM stamps `user` from the authenticated sender).

## Event

| Field | Notes |
|---|---|
| `id` | `<clientId>.<seq>`, unique per session; `ffr import` dedups on `(session, id)` |
| `seq` | per client instance, assigned when an event is queued for sending. Gaps = lost telemetry |
| `type` | dotted, e.g. `ui.app.open`; category = first segment |
| `t` | client epoch ms (skewed); the database stores `tc` = corrected time and `recv` (file write time) |
| `mono` | `performance.now()` (ms since page load) for intra-client ordering |
| `sev` | debug, info, notice, warn, error, critical |
| `scene` | active scene id |
| `combat` | `{id, round, turn}` when a combat is started |
| `span` | `{id, ph: "b"|"e"|"i", kind, out}` interaction span begin/end + outcome |
| `parent`, `corr` | causal links (span end → begin event) |
| `dk` | dedup key for globally observable events recorded by several clients |
| `local` | true = initiated by this client's user; false = observed (active GM recording others) |
| `mode` | collection mode when emitted (`normal`/`detailed`/`diagnostic`) |
| `sample` | `context` = held in the ring buffer, sent because a trigger followed |
| `data` | sanitized payload (≤ 16 KiB per event, depth ≤ 6, arrays ≤ 50, strings ≤ 2000) |

## Collection levels

An event is sent when its level ≤ the current mode (`normal` 0, `detailed` 1, `diagnostic` 2).
Every event, sent or not, enters a 300-event ring buffer. **Triggers** (`err.*`, `perf.stall`,
`friction.mark`) promote unsent ring events (marked `sample: "context"`) and escalate to `diagnostic` for 60 s
(at most every 30 s). Per-type (20/s, burst 60) and global (150/s, burst 400) token buckets sample out
floods; counts are reported in `rec.loss.data.sampledOut`. Triggers are never sampled out.

## Event types

| Type | Lvl | Recorded by | Data (main fields) |
|---|---|---|---|
| `session.start` / `session.stop` | 0 | GM | `label` |
| `rec.start` / `rec.stop` | 0 | each client | session, version, adapters, reason |
| `rec.mode` | 0 | each | escalation: mode, reason, promoted |
| `rec.loss` | 0 | each | `sampledOut{type:n}`, `dropped`, `totalDropped` |
| `rec.adapter` | 0 | each | `{id, ok, error}` |
| `client.load` / `client.unload` | 0 | each | readyMs, transferKb |
| `client.visibility` | 0 | each | state |
| `client.idle` | 0 | each | span; idle after 90 s without input |
| `env.snapshot` | 0 | each | foundry/system/world, browser, gpu, perf support, fingerprints `fp{core,modules,settings,all}` |
| `env.modules` / `env.settings` | 0 | each | chunks of `{id: version}` / `{"ns.key": value}` (filtered, see privacy) |
| `err.js` / `err.promise` / `err.foundry` / `err.console` | 0 | each | msg, stack, top (package of the throw site), origins (all packages in the stack), versions, fp (fingerprint), file/line, location. `err.js`/`err.promise`/`err.foundry` are captured from module import on, so errors in other packages' init/setup/ready are included (packages imported before this one are not) |
| `hook.veto` | 0 | each | a pre* hook listener returned `false` (action cancelled): hook, pkg (registering package, `untagged` if registered before this module loaded), fn name |
| `rec.profiling` | 0 | each | hook timing suspended: reason (`overhead`, `hooks-replaced`), overheadMs |
| `lw.conflict` | 0 | each | libWrapper's `libWrapper.ConflictDetected` hook: a, b (package ids), target (wrapped method) |
| `warn.console` | 1 | each | same as errors |
| `ui.notify` | 0 (info: 1) | each | kind, msg (rendered notification text) |
| `ui.app.open` / `ui.app.close` | 0 | each | span; cls, appId, doc ref, title |
| `ui.tab` | 0 | each | tab, group, cls |
| `ui.action` | 0 | each | `data-action`, cls, item ref, slug/statistic; PF2e adapter adds `strike`, `variant` (0/1/2 = MAP step), `spellGroup` (rank or "cantrips"), `slot`, `readsRules` (item rules text expanded) |
| `ui.click` | 1 | each | generic fallback: tag, cls, classes, tooltip, docId |
| `ui.focus` | 1 | each | field name, kind, cls (never the value; password fields skipped) |
| `ui.sidebar` / `ui.layer` | 0 / 1 | each | tab / layer |
| `token.control` / `token.target` / `token.move` | 0 | own user | token/actor refs; targeted, nTargets; waypoints, distance, cost, method |
| `scene.load` | 0 | each | span canvasInit → canvasReady (`dur`) |
| `scene.summary` | 0 | each | size, grid, vision, fog, light, darkness, counts (tokens, lights, walls, …), animated lights |
| `scene.teardown` | 0 | each | |
| `doc.create` / `doc.delete` | 0 | initiator | doc ref, parent ref |
| `doc.update` | 1 (HP: 0) | initiator | changed key paths (no values), HP value/temp/max |
| `chat.message` | 0 | author + active GM | msg id, style, rolls (formula, total, dice), whisper count, blind, speaker ids, flag scopes, corr `chat:<userId>:<timestamp>` for rolls. **Never content** |
| `chat.origin` | 0 | creating client | before a roll message is created: rolls count, origins (packages on the creating stack, top first), macro (bool), stack (code locations only). Same corr as its `chat.message` |
| `combat.start` / `combat.round` / `combat.end` | 0 | active GM | counts, round |
| `combat.turn` | 0 | active GM | span per turn: combatant, actor, pc, round, turn |
| `pf2e.check` | 0 | author + GM | ctype, outcome, unadjusted, dc, statistic, domains, traits, target present, isReroll, roll |
| `pf2e.action` | 0 | author + GM | item card without check: actionType, actions, traits, rank |
| `pf2e.turn` | 0 | active GM | `pf2e.startTurn/endTurn` |
| `pf2e.reroll` | 0 | own | resource, keep, old/new total |
| `pf2e.damage` | 1 | own | roll |
| `pf2e.condition` | 0 | initiator | op, condition/effect item ref, value, badge |
| `perf.window` | 0 | each | every 10 s: fps, p50/p95/p99/max frame ms, long tasks, LoAF (top origins), heap, hidden ms, hookTime (`diagnostic` mode only: top packages by synchronous hook-listener time {calls, ms, max, maxHook}) + hookOverheadMs, latencyMs (Foundry's own one-way client-server estimate, `game.time.averageLatency`), counts of expensive hooks |
| `perf.stall` | 0 | each | frame ≥ 1000 ms: ms, LoAF script attribution, hook counts |
| `perf.loaf` | 1 | each | long animation frame ≥ 200 ms with scripts |
| `net.socket` / `net.online` | 0 | each | Foundry socket connect/disconnect/reconnect; browser online |
| `user.connection` | 0 | active GM | user pseudonym, connected |
| `friction.mark` | 0 | each | cat, note (user-typed, ≤ 300 chars, untrusted), recent event types, open windows |
| `dsn.roll` | 1 | own | Dice So Nice animation span |

Refs (`ref()`): `{uuid, doc, type, slug, name?, pc?}`; names only when the world setting
"Record entity names" is on.

## Storage (SQLite)

Built by `ffr import`: `sessions`, `clients` (per client instance: counts, skew, dropped), `batches` (import
log), `events` (columns mirror the event, `data` as JSON). See [`packages/analysis-cli/db.mjs`](../packages/analysis-cli/db.mjs).

## Versioning

Additive changes (new types, new data fields) keep `v: 1`. A breaking envelope/event change bumps
`SCHEMA_VERSION`; `ffr import` then needs to accept both during the transition.
