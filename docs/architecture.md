# Architecture and decisions

```
 player/GM browsers (Foundry V14 client)              host (next to Foundry)
 ┌──────────────────────────────────────┐   HTTPS    ┌───────────────────────────┐
 │ foundry-flight-recorder module       │  POST      │ collector (node:http)     │
 │  capture.mjs  hooks/DOM/errors       │ /v1/ingest │  validate → sanitize →    │
 │  perf.mjs     rAF, LoAF, longtask    │──────────▶ │  SQLite (node:sqlite, WAL)│
 │  adapters/    pf2e, dice-so-nice     │  append    │  ingest-only, no reads    │
 │  recorder.mjs ring, queue, batching, │  only key  └─────────────┬─────────────┘
 │               retry, persistence     │                          │ local file access
 └──────────────────────────────────────┘             ┌────────────▼─────────────┐
                                                      │ ffr CLI (analysis-cli)    │
                                                      │ ← Codex / GM (AGENTS.md)  │
                                                      └───────────────────────────┘
```

## Components

| Path | Role |
|---|---|
| `packages/schema/schema.mjs` | envelope/event validation, limits, sanitization, error fingerprint, module attribution |
| `packages/foundry-module/` | Foundry module (`module.json`, `scripts/*.mjs`, no bundler, no dependency) |
| `packages/collector/` | `server.mjs` HTTP ingest, `db.mjs` storage + admin ops (retention, deletion, finalize) |
| `packages/analysis-cli/` | `analyze.mjs` deterministic analyses, `ffr.mjs` CLI |
| `tests/` | `node:test` suites, `fixtures/synth.mjs` synthetic sessions, `load.mjs`, `e2e/` real Foundry run |

## Decisions (ADR log)

1. **Zero runtime dependencies, plain ES modules, Node ≥ 22.13.** `node:sqlite`, `node:http`, `node:test`
   cover storage, HTTP and tests. No build step except copying the shared schema into the module.
   *Why:* smallest supply-chain and maintenance surface; Codex and Claude read the code directly.
   *Trade-off:* no TypeScript type checking; `node:sqlite` prints an ExperimentalWarning (suppressed).
   *Revisit:* if the codebase grows past a few thousand lines, add JSDoc `// @ts-check` + `tsc --noEmit`.
2. **One shared schema module.** The browser and server import the same file (`scripts/schema.mjs` is a
   symlink; the build materializes it). Sanitization runs twice: client before queueing, server on ingest.
3. **Ingest-only HTTP; administration through local CLI.** The ingest key is visible in every browser
   (world setting), so it only appends. Reading, exporting, deleting require shell access to the DB file.
   No admin web UI exists to secure.
4. **SQLite as the index, JSONL as export.** One file per deployment, WAL mode; `ffr export` produces
   time-ordered JSONL. No separate append-only archive (would double writes for little gain).
5. **Event ids = `clientId.seq`**, seq assigned when an event is queued. Retries and unload re-sends are
   idempotent; sequence gaps measure real loss (sent-but-lost or dropped), not filtering.
6. **Clock skew**: per client instance, `skew = min(recv − sentAt)`; `tc = t + skew`. Bounded error =
   network latency of the fastest batch. Ordering: `tc` across clients, `seq`/`mono` within a client.
7. **Duplicates across clients** are explicit: `local` (initiator vs observer) + `dk` dedup key; analysis
   dedups, storage keeps every observation.
8. **Who records what**: user-initiated things on the initiator's client; globally observable things
   (combat turns, chat of others, connections) on the active GM only. Players who opt out stay invisible.
9. **Adaptive capture**: three modes + ring buffer + trigger escalation (see telemetry-schema.md).
10. **Passive capture only**: `Hooks.on` handlers wrapped in try/catch returning nothing (never vetoing),
    capture-phase passive DOM listeners, MutationObserver on `#notifications`, PerformanceObserver.
    The only wrapper is `console.error/warn` (calls the original first; can be disabled by setting).
11. **No dashboard.** The analyst is Codex with a CLI; humans read the generated report.
13. **Collector-less default storage** (module persistent storage on the Foundry server). Modules run no
    server code, so the only server writes available are Foundry's own upload endpoint (permission
    *Upload Files*, global) and world documents (would bloat the world database and broadcast changes).
    Clients that may upload write their own batch files, one per batch (non-media files cannot be
    overwritten: "already exists" on retry means stored); others relay over the module socket to the active
    GM only, who writes and acks. *Why:* running an extra server and a reverse proxy kills adoption.
    *Trade-off:* Foundry serves `Data/` publicly (unguessable names, but browsable with *Browse File
    Explorer*); recording of non-uploading players needs a GM online; no retention. The collector stays.
12. **Text/plain JSON POST** avoids CORS preflight; `sendBeacon` + localStorage persistence on `pagehide`.

## Foundry V14 / PF2e integration points (verified)

Verified by reading the shipped client source of Foundry **14.369** and PF2e **8.6.1**, and by the real
runtime e2e run (see validation.md).

| Capability | API | Status |
|---|---|---|
| Lifecycle | `Hooks.once("init"/"ready")` | official |
| Window open/close | `render{Class}` / `close{Class}` for every class in the AppV2 chain → `renderApplicationV2`, `closeApplicationV2`; AppV1: `renderApplication`, `closeApplication` | official (AppV1 deprecated) |
| Tabs | AppV2 `changeTab()` has **no hook**; captured via delegated click on `[data-tab]` in nav | DOM, structural |
| Buttons | AppV2 `data-action` attributes (delegated click) | DOM convention |
| Documents | `create/update/delete{Document}` (doc, data/change, options, userId) | official |
| Tokens | `controlToken(token, controlled)`, `targetToken(user, token, targeted)`, `moveToken(doc, movement, operation, user)` | official (moveToken new in V13+) |
| Canvas | `canvasInit`, `canvasReady`, `canvasTearDown`; counted: `sightRefresh`, `lightingRefresh`, `initializeVisionSources`, `initializeLightSources`, `refreshToken`, `canvasPan` | official |
| Combat | `combatStart(combat, update)`, `combatRound`, `combatTurn` (pre-update), `combatTurnChange(combat, prior, current)` (all clients, after update), `deleteCombat` | official |
| Chat | `createChatMessage`; `message.rolls`; never `content` | official |
| Errors | `Hooks.onError` → `Hooks.callAll("error", location, error, data)`; `window` `error`/`unhandledrejection` | official / web |
| Notifications | no hook; `<ol id="notifications">` children observed | DOM, internal markup |
| Sidebar/layers | `changeSidebarTab`, `activate{Layer}`→`activateCanvasLayer` | official |
| Connection | `game.socket` (socket.io) `connect`/`disconnect`, `socket.io` `reconnect*`; `userConnected(user, connected)` | socket: semi-internal |
| PF2e | `pf2e.startTurn/endTurn(combatant, encounter, userId)`, `pf2e.reroll(old, new, resource, {keep})`, `pf2e.damageRoll(roll)`; `flags.pf2e.context` (`type`, `outcome`, `unadjustedOutcome`, `dc`, `domains`, `traits`, `target`), `flags.pf2e.origin.uuid`; conditions = Items `type: "condition"` | system hooks/flags, not a stable public API: every access optional |
| Performance | `PerformanceObserver` `longtask`, `long-animation-frame` (Chromium 123+), `performance.memory` (Chromium), rAF | web, feature-detected |

**Not available / not captured:** tab changes in AppV1 sheets without `data-tab` navs; PF2e check dialog
outcome (no hook — inferred from window close + absence of a roll, see `repeats`); per-module CPU/GPU
attribution (LoAF gives script involvement only); Firefox/Safari have no LoAF/longtask/memory (frame times
still measured); keystrokes and typed text (by design); voice (out of scope).

### Future: voice transcription
Out of scope. If added, it should be a separate opt-in pipeline (local Whisper on the GM host), producing
`voice.segment` events with speaker pseudonym and time span only, never stored audio, and its own consent.
