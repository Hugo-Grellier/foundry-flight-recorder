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
1. One e2e run lost the GM's last events before the close()/fetch-timeout mitigation; root cause unconfirmed.
2. Validate with real players (consent UX, multi-hour stability, Firefox clients).
3. Overhead measurement on a GPU-backed browser with repeated A/B runs.
5. P2: per-sheet semantic maps (PF2e strike/spell buttons), statistical anomaly baselines, multi-session trends,
   libWrapper-level attribution.
6. Localization (module UI strings are English only).
