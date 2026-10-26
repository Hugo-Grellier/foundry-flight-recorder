# Foundry Flight Recorder

Session flight recorder for **Foundry VTT V14** (optimized for **Pathfinder 2e** and module-heavy worlds).
Participating browsers passively record errors, UI interactions, PF2e semantics, combat flow and
performance; a self-hosted collector stores them in SQLite; the `ffr` CLI lets **Codex** (or you) investigate
a session after play and produce an evidence-based report. Recording requires each participant's consent.

```
browsers (module) ──POST /v1/ingest──▶ collector (SQLite) ◀── ffr CLI ◀── Codex + AGENTS.md
```

Status: v0.1.0. Unit/synthetic tests and a real Foundry 14.369 + PF2e 8.6.1 run pass (see
[docs/validation.md](docs/validation.md)). Not yet used in a real session with human players.

## Quick start

Requirements: Node ≥ 22.13 (no npm dependencies) or Docker; Foundry V14.

```bash
# 1. collector
cp .env.example .env        # FFR_INGEST_KEY=$(openssl rand -hex 24), FFR_ALLOWED_ORIGINS=<your Foundry origin>
docker compose -f docker/compose.yml --env-file .env up -d --build
#    or: FFR_INGEST_KEY=... FFR_ALLOWED_ORIGINS=http://localhost:30000 npm run collector

# 2. module: in Foundry, Install Module → Manifest URL
#    https://github.com/Hugo-Grellier/foundry-flight-recorder/releases/latest/download/module.json
#    or build it yourself:
npm run build               # dist/foundry-flight-recorder(.zip)
node scripts/build-module.mjs --install /path/to/FoundryData/Data/modules   # then restart Foundry
```

UI in English and French (follows the Foundry language). In the world: enable *Flight Recorder* → *Configure Settings*: **Enable**, **Collector ingest URL**
(`http://<host>:4318/v1/ingest`, HTTPS behind a proxy if Foundry is HTTPS), **ingest key**.

Record: GM clicks the badge at the top of the screen → *Start session*. Players accept the consent dialog.
Anyone: **Alt+Shift+F** marks a friction moment. GM → *Stop session* at the end.

Investigate:

```bash
export FFR_DB=./data/ffr.db
npm run -s ffr -- sessions
npm run -s ffr -- digest latest --out /tmp/digest.json
npm run -s ffr -- around latest --event <id> --before 30s
codex "Investigate the latest recorded session following AGENTS.md and write the report"
```

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
`packages/analysis-cli`, `tests/`, `docker/`, `docs/`.
