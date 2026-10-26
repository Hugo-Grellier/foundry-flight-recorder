# Progress log

## 2026-10-22 — session 1
- Research: hooks verified against real Foundry 14.369 client source and PF2e 8.6.1 (see docs/architecture.md).
- Schema + collector (node:sqlite, ingest-only HTTP).

## 2026-10-22 — session 2
- Foundry module: recorder core (ring buffer, modes, escalation, rate limits, bounded queue, retry,
  beacon/persistence), capture (errors, notifications, windows, tabs, actions, focus, idle, canvas, tokens,
  documents, chat, combat, network), perf (rAF, longtask, LoAF, stalls), env snapshot, PF2e + Dice So Nice
  adapters, consent dialog, REC badge, friction keybinding, GM start/stop, macro API.
- Analysis library + `ffr` CLI; synthetic two-session generator; 47 tests; load test; Docker image + compose.
- Real e2e on the local Foundry container (world maxi-modtest, under `flock /tmp/maxi.lock`): 6 bugs found and
  fixed (docs/validation.md §3). Final runs 37/37. World restored after every run (module disabled, test scene removed).
- Codex CLI investigated the synthetic dataset via AGENTS.md: examples/report-synthetic-session.md.

## 2026-10-26 — session 3 (lab frozen by the lab lead: no runtime tests)
- Runner integration for foundry-maxi-lab (`tools/maxi-runner.mjs`, MAXI_FFR=1 patch sent to the lab lead).
- EN/FR localization of every module string (lang files + key-coverage test).
- PF2e sheet enrichment via adapter `enrich()`: strike + MAP variant, spell rank/slot, rules-text lookups;
  surfaced in `ffr pf2e` (`rulesLookups`, `strikeVariantsMAP`).
- `ffr trend`: per-session metrics over time, config-change flag, recurring error fingerprints.
- HTTPS reverse proxy exercised with Caddy + collector image (docs/validation.md §5).
- Pending: real-runtime verification of the above (`npm run e2e`) once the lab lead releases the lab.

## Decisions
See docs/architecture.md (ADR log).

## Open issues / next
1. One e2e run lost the GM's last events before the close()/fetch-timeout mitigation; most likely a hung fetch
   + early-returning flush (both fixed and tested), not proven on the runtime.
2. Validate with real players (consent UX, multi-hour stability, Firefox clients).
3. Overhead measurement on a GPU-backed browser with repeated A/B runs.
5. P2: per-sheet semantic maps (PF2e strike/spell buttons), statistical anomaly baselines, multi-session trends,
   libWrapper-level attribution.
6. Localization (module UI strings are English only).

## 2026-10-26 — first prod session (pf2e-beginner-box, GM only, ~35 s, local collector)
- 69 events, 0 rejected, 0 sequence gaps, clean stop. Found: 4.7 s freeze attributed by LoAF to `babele`
  (`Response.json.then`); PF2e/workbench "must target" error notification captured.
- Bug: an escalation triggered while pending (load-time freeze) survived `disable()`, so every session event was
  tagged `diagnostic` with no `rec.mode` explaining it. Fixed (disable resets escalation) + regression test.

## 2026-10-26 — public repo + collector-less storage (v0.2.0, unreleased)
- Public repo github.com/Hugo-Grellier/foundry-flight-recorder (MIT), release workflow from the League template.
- Consent per account (user-scoped setting); hook errors attributed via libWrapper's `[Detected packages]` note.
- Default storage = files in the module's persistent storage on the Foundry server (store.mjs, `ffr import`).
  Verified against the V14 server code (upload rules, socket recipients, static serving of Data/); unit and
  import tests pass. Pending: one real-runtime check of the Foundry glue (upload, createDirectory, socket relay)
  before tagging v0.2.0.
- Docker packaging removed (collector stays as an optional Node process). Prod collector, its Traefik route
  (homelab revert 9d111d6) and the prod module copy removed; the module is to be reinstalled from the manifest.
  Final prod DB (2 sessions) kept outside the repo.
