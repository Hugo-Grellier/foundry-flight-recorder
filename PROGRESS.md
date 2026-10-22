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

## Decisions
See docs/architecture.md (ADR log).

## Open issues / next
1. One e2e run lost the GM's last events before the close()/fetch-timeout mitigation; root cause unconfirmed.
2. Validate with real players (consent UX, multi-hour stability, Firefox clients).
3. Overhead measurement on a GPU-backed browser with repeated A/B runs.
4. HTTPS reverse-proxy deployment test.
5. P2: per-sheet semantic maps (PF2e strike/spell buttons), statistical anomaly baselines, multi-session trends,
   libWrapper-level attribution.
6. Localization (module UI strings are English only).
