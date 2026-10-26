# Foundry Flight Recorder

Session flight recorder for **Foundry VTT V14** (optimized for **Pathfinder 2e** and module-heavy worlds).
Participating browsers passively record errors, UI interactions, PF2e semantics, combat flow and
performance; a self-hosted collector stores them in SQLite; the `ffr` CLI lets **Codex** (or you) investigate
a session after play and produce an evidence-based report. Recording requires each participant's consent.

```
browsers (module) ──▶ JSON files on the Foundry server ──ffr import──▶ SQLite ◀── ffr CLI ◀── Codex + AGENTS.md
                   └──▶ optional self-hosted collector (Node) ───────────────▶┘
```

No extra server is needed: recordings are stored by Foundry itself. A collector is optional.

Status: v0.1.0 released, v0.2.0 in progress. Unit/synthetic tests and real Foundry 14.369 + PF2e 8.6.1 runs
(see [docs/validation.md](docs/validation.md)); first real sessions with players in progress.

## Quick start

1. In Foundry: *Install Module* → Manifest URL
   `https://github.com/Hugo-Grellier/foundry-flight-recorder/releases/latest/download/module.json`
2. In the world: enable *Flight Recorder*, then *Configure Settings* → **Enable**. Leave *Collector ingest URL*
   empty: recordings go to `Data/modules/foundry-flight-recorder/storage/` on the Foundry server.
3. Record: GM clicks the badge at the top of the screen → *Start session*. Players accept the consent dialog
   (asked once per account). Anyone: **Alt+Shift+F** marks a friction moment. GM → *Stop session*.
4. Investigate (Node ≥ 22.13, no npm dependencies) on a copy of that folder:

```bash
rsync -a foundry:/path/to/Data/modules/foundry-flight-recorder/storage/ ./ffr-storage/
export FFR_DB=./data/ffr.db
npm run -s ffr -- import ./ffr-storage
npm run -s ffr -- sessions
npm run -s ffr -- digest latest --out /tmp/digest.json
npm run -s ffr -- around latest --event <id> --before 30s
codex "Investigate the latest recorded session following AGENTS.md and write the report"
```

UI in English and French (follows the Foundry language). Optional self-hosted collector (Node process, central
database, retention, stricter privacy) and HTTPS setup: [docs/deployment.md](docs/deployment.md).

Try it without Foundry: `npm run -s fixtures -- --db /tmp/fx.db` generates two synthetic PF2e sessions
(targeting struggle, injected module error, freeze, disconnect, config change between sessions).

## Documentation

| | |
|---|---|
| [AGENTS.md](AGENTS.md) | investigation workflow and grounding rules for Codex |
| [docs/deployment.md](docs/deployment.md) | collector config, reverse proxy/HTTPS, module setup, recording |
| [docs/privacy.md](docs/privacy.md) | consent, what is/is never collected, security model, retention, deletion |
| [docs/telemetry-schema.md](docs/telemetry-schema.md) | envelope, event fields, every event type |
| [docs/architecture.md](docs/architecture.md) | components, decisions, verified Foundry/PF2e APIs, limits |
| [docs/report-template.md](docs/report-template.md) | post-session report format |
| [docs/adapters.md](docs/adapters.md) | adding system/module adapters |
| [docs/troubleshooting.md](docs/troubleshooting.md) | common problems |
| [docs/validation.md](docs/validation.md) | tests, real runtime validation, overhead measurements |

Releasing: publish a GitHub release tagged `vX.Y.Z`; `.github/workflows/release.yml` runs the tests and attaches
`module.json` + `module.zip` stamped with that version.

## Development

```bash
npm test                 # node:test: schema, recorder, collector, analysis on synthetic sessions
npm run load             # multi-client ingestion load test
flock /tmp/maxi.lock npm run e2e   # real Foundry run (needs a local licensed Foundry + Playwright)
```

Layout: `packages/schema` (shared), `packages/foundry-module`, `packages/collector`,
`packages/analysis-cli`, `tests/`, `docs/`.
