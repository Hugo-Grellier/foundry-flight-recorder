# Progress log

## 2026-10-22 — session 1 (stopped at usage limit)
Done:
- Research: hooks verified against real Foundry 14.369 source (container `foundry-local`) and PF2e 8.6.1
  (`pf2e.startTurn/endTurn/reroll/preReroll/damageRoll`, AppV2 `render{Class}`/`close{Class}`, `combatTurnChange`,
  `moveToken`, `targetToken`, `control{Token}`, `Hooks "error"`, socket.io connect/disconnect, `#notifications` <ol>).
- packages/schema/schema.mjs: versioned envelope/event validation, sanitize/scrub, error fingerprint, module attribution.
- packages/collector/{db.mjs,server.mjs}: node:sqlite storage (no deps), ingest-only HTTP, key + origin + size + rate +
  storage limits, dedup by event id, clock-skew estimate (min recv-sentAt), lifecycle, retention, user/session deletion.
- Manual smoke test: ingest 200, duplicate counted, bad key 401, `password` key redacted.

Next (priority order): Foundry module (recorder core, ring buffer, batching/retry, consent UI, hooks, perf, PF2e adapter),
analysis CLI (sessions/info/timeline/around/errors/turns/perf/repeats/compare/digest/export), node:test suite,
synthetic fixture generator, AGENTS.md + README + docs, Docker, real e2e against foundry-local (use `flock /tmp/maxi.lock`).
