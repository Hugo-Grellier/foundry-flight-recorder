# Validation

Date: 2026-10-22. Host: Ryzen 7 7840HS, 16 threads, Linux, Node 22.23.4.

## 1. Automated tests (`npm test`) — synthetic / mocked

57 tests, all passing (`node:test`) as of 2026-10-26 (47 at the real-runtime validation of 2026-10-22):

| Suite | Covers |
|---|---|
| `tests/schema.test.mjs` | envelope/event validation, size limits, sanitization and scrubbing (JWT, bearer, email, IP, URL secrets), fingerprints, stack attribution (throw site vs wrappers) |
| `tests/recorder.test.mjs` | pending→active buffering, mode filtering, ring-buffer promotion + diagnostic escalation, retry/backoff, no retry on 4xx, bounded queue + loss reporting, rate limiting (never on lifecycle/triggers), spans, unload persistence + restore (stable ids), opt-out, concurrent flush, close() persistence across sessions, client-instance rotation |
| `tests/collector.test.mjs` | real HTTP: accept/dedup, key (body/header), origin allowlist + CORS preflight, 413/400/schema, no read endpoints, server-side sanitization, clock-skew correction + out-of-order arrival, lifecycle (start/stop/idle), retention, user/session deletion, 429, 507 |
| `tests/analysis.test.mjs` | synthetic 2-session PF2e dataset produced by the real Recorder → real Store, then the CLI: listing, coverage (crash, disconnect, drops, 90 s clock skew), injected error + its ring-buffer context, repeated/failed interaction patterns without psychological wording, slow turn, freeze attribution, friction marker, anomaly ranking, session comparison (config diff + perf/turn/error deltas), timeline filters, digest bounds, analysis without a GM client, JSONL export, read-only guarantees |

The synthetic dataset (`tests/fixtures/synth.mjs`): 4 participants (GM + 3 PCs), 3 combat rounds, sheet
exploration, a 250 s turn with abandoned roll dialog / repeated warnings / target toggling / attack without
target / friction marker, an injected `pf2e-toolbelt` error preceded by detailed-level context, a 2.4 s
freeze attributed to FXMaster on a weak client, a socket disconnect + crash + reload, a collector outage
causing queue overflow, then a second session after a configuration change (module removed/upgraded,
setting changed).

## 2. Load (`npm run load`) — synthetic

12 clients × 5,000 events (detailed mode) over real HTTP into one collector (`tests/load.mjs`):
60,000/60,000 stored, 0 missing, **≈23,000 events/s**, batch latency p50 52 ms / p95 77 ms / max 128 ms
(200-event batches), 30 MB database. `Recorder.emit()` in Node: ≈9 µs per sent event, ≈8 µs ring-only.
A real 4-6 player session produces on the order of 5-30 events/s in total.

## 3. Real runtime — Foundry VTT 14.369 + PF2e 8.6.1 (licensed local instance)

`tests/e2e/foundry-e2e.mjs`, headless Chromium (Playwright), world `maxi-modtest` with **150 active
modules**, GM + one Player browser, collector in-process. Final result: **37/37 checks passed**
(`tests/.tmp/e2e-results.json`, not committed). Verified on the real runtime:

- module loads in V14; settings, consent (participation), GM start/stop session API; both clients record;
- player reload resumes as a new client instance; no sequence gaps on any client;
- env snapshot (150 modules with versions, filtered settings without the ingest key), scene load spans and summaries;
- PF2e AppV1 character sheet open/close, tab clicks, targeting, token control, combat start/turn spans/end,
  chat roll metadata, `pf2e.check` (perception) with context type and actor, `pf2e.turn`, conditions/doc updates;
- injected `window` error grouped and its preceding 30 s window reconstructed across clients;
- simulated 1.6 s main-thread freeze detected (`perf.stall`) with LoAF data; friction marker with context;
- no chat content, HTML or ingest key in storage; world restored afterwards (module disabled, test scene deleted).

It also captured genuine problems of that lab world, e.g. `pf2e-visioner` "Cannot read properties of null
(reading 'combatants')" on turn change and `tokenmagic` "PIXI.RenderTexture.create is not a constructor".

Bugs found by the real runs and fixed (all covered by regression tests since):
1. PF2e V1 sheets fire `renderActorSheet` but not `renderApplication` in V14 → sheets were invisible.
2. Frameless persistent UI (Sidebar, Players, HUD panels) was reported as "opened windows".
3. `flush()` returned early while a send was in flight; `disable()` then dropped `session.stop`.
4. Lifecycle events could be rate-limited after a burst.
5. Events buffered before a session consumed sequence numbers → false "missing telemetry".
6. Errors attributed to a timer-wrapping module lower in the stack → throw site now separated.
One earlier run lost the GM's final events without a confirmed root cause; the mitigation (`close()` persists
undeliverable events for re-send, 15 s fetch timeout) passed the following runs, but the root cause is
**not proven**. Most likely explanation, consistent with every observation of that run (no GM batch at all
after +85 s, `api.stop()` returning instantly, queue dropped): one GM `fetch` never settled; the old
`flush()` returned immediately while a send was in flight, so stop + `disable()` discarded the queue. Both
halves are fixed and regression-tested (concurrent flush waits; hung send aborted after 15 s and retried).

### Overhead (real runtime, GM browser)

Two runs (run 4 / run 5):

| Workload | Module inactive (before) | Recording | Module inactive (after) |
|---|---|---|---|
| 8× open+close PF2e sheet | 7.2 / 6.9 s | 7.6 / 9.5 s | 25.1 / 36.2 s |
| 100 target toggles | 24 / 15 ms | 54 / 108 ms | 27 / 38 ms |
| frame time p50 (5 s, idle) | 133 / 133 ms | 267 / 383 ms | 267 / 350 ms |

In-page `emit()` microbenchmark: **2.6 / 6 µs per event**. Interpretation: this headless, software-rendered
150-module world is very noisy and degrades over a run (the "after" baseline is 3.5-5× slower than "before"
for sheets), so sheet and frame figures do not isolate the recorder. Target toggling is the only cost that
is consistently higher while recording (≈0.15-0.24 ms → 0.5-1.1 ms per toggle including the hook chain and
emits); it stays well below one frame per user action. A proper overhead
measurement needs a GPU-backed browser and repeated A/B runs: **not done**.

## 4. Codex investigation — real Codex CLI on synthetic data

`codex exec` (codex-cli 0.163.0) was given only: investigate session A following AGENTS.md, compare with
B, write `examples/report-synthetic-session.md`, do not read `tests/`. The report recovered every planted
issue (targeting struggle, Toolbelt error with its context, FXMaster freeze on the weak client, slow loads,
disconnect + reload, collector loss) with evidence ids, alternatives and confidence, treated the friction
note as untrusted text, and refused causal claims from the session comparison. Event ids in the example
refer to the dataset generated at that time (ids are random per generation).

## 5. HTTPS reverse proxy (2026-10-26)

Collector Docker image (`FFR_TRUST_PROXY=1`, origin `https://foundry.example.org`) behind Caddy 2 with
`tls internal` and `handle_path /ffr/* { reverse_proxy 127.0.0.1:<port> }`: `GET /ffr/healthz` OK; `POST
/ffr/v1/ingest` HTTP/2 200 with `Access-Control-Allow-Origin: https://foundry.example.org`; foreign origin 403;
CORS preflight 204; event stored and listed by `ffr sessions` inside the container. No browser in the loop
(curl with an Origin header).

## Not validated

- Added after the last real-runtime run (2026-10-26, lab frozen by its owner): French/English localization,
  PF2e sheet enrichment (strike MAP variant, spell rank/slot, rules-text lookups), `ffr trend`,
  `tools/maxi-runner.mjs`. Covered by unit/synthetic tests only; to re-run `npm run e2e` when the lab is free.

- A real session with human players (behaviour, consent UX, multi-hour stability, real network loss).
- Firefox/Safari clients (no LoAF/long tasks/memory; DOM capture unverified).
- nginx variant of the reverse proxy (only the Caddy variant was exercised, see §5).
- Overhead on GPU-backed browsers.
