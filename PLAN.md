# Plan and acceptance checklist

Priorities from the mission brief: P0 vertical slice → P1 post-session intelligence → P2 advanced.
Status legend: [x] done and tested, [~] partial (see note), [ ] not done.

## P0 — functional vertical slice
- [x] Foundry module initialization (V14 manifest, esmodule, settings, keybinding)
- [x] Session lifecycle (GM start/stop, world setting propagation, collector start/stop/idle finalize)
- [x] Client error capture (window error, unhandledrejection, Hooks "error", console.error/warn)
- [x] Foundry hook capture (documents, tokens, canvas, combat, chat, sidebar/layers, connection)
- [x] Basic UI interaction capture (windows V1+V2, tabs, data-action, generic click, focus, idle)
- [x] Telemetry batching (bounded queue, batch size/bytes, retry/backoff, 4xx no-retry, beacon + persistence)
- [x] Server ingestion (validation, sanitization, key, origin, size, rate, storage cap)
- [x] Persistent storage (SQLite WAL outside Foundry Data)
- [x] Privacy controls (per-client consent, opt-out, badge, minimization, retention, deletion)
- [x] CLI session listing and timeline
- [x] End-to-end synthetic test (tests/analysis.test.mjs) and real Foundry run (tests/e2e)

## P1 — post-session intelligence
- [x] PF2e semantic adapter (checks/outcomes, actions, turns, rerolls, damage, conditions)
- [x] Error-context ring buffer + diagnostic escalation
- [x] Performance metrics (frame times, long tasks, LoAF attribution, stalls, scene load, hook counts)
- [x] Configuration snapshots + fingerprints
- [x] Event correlation (spans, parent, dedup keys, clock-skew correction)
- [x] Evidence-window queries (`around`)
- [x] Session comparison (`compare`)
- [x] Codex documentation (AGENTS.md, report template)
- [x] Realistic fixtures (tests/fixtures/synth.mjs)

## P2 — advanced
- [~] Advanced UI semantics: data-action/item resolution; no per-sheet semantic maps yet
- [~] Module attribution: stack origins + LoAF script origins; no libWrapper-level attribution
- [x] Adaptive diagnostic tracing
- [~] Anomaly heuristics: fixed rules (repeats, toggling, abandoned dialog, slow turns); no statistical baselines
- [~] Cross-session friction analysis: pairwise `compare`; no multi-session trend command
- [x] Optional extension adapters (adapter interface, dice-so-nice)

## Definition of done (mission §15)
1. [x] module builds/installs  2. [x] client initiates recording  3. [x] multiple clients
4. [x] errors/UI/Foundry events  5. [x] storage outside Foundry Data  6. [x] reconnect/disconnect tolerant
7. [x] list + time-bounded sequences  8. [x] injected error + context  9. [x] repeated/failed interactions without psychology
10. [x] session comparison  11. [x] privacy/retention  12. [x] tests  13. [x] README deployment  14. [x] Codex workflow
