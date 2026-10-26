# Foundry Flight Recorder

Session flight recorder for **Foundry VTT V14** (optimized for **Pathfinder 2e** and module-heavy worlds).
Participating browsers passively record errors, UI interactions, PF2e semantics, combat flow and
performance; Foundry stores them as files on its server; the `ffr` CLI imports them into SQLite and lets **Codex** (or you) investigate
a session after play and produce an evidence-based report. Recording requires each participant's consent.

```
browsers (module) ──▶ JSON files on the Foundry server (Data/flight-recorder) ──ffr import──▶ SQLite ◀── ffr CLI ◀── Codex / Claude (investigate-session skill)
```

No extra server is needed: recordings are stored by Foundry itself.

Status: v0.1.0 released, v0.2.0 in progress. Unit/synthetic tests and real Foundry 14.369 + PF2e 8.6.1 runs
(see [docs/validation.md](docs/validation.md)); first real sessions with players in progress.

## Quick start

1. In Foundry: *Install Module* → Manifest URL
   `https://github.com/Hugo-Grellier/foundry-flight-recorder/releases/latest/download/module.json`
2. In the world: enable *Flight Recorder*, then *Configure Settings* → **Enable**. Recordings go to
   `Data/flight-recorder/` on the Foundry server.
3. Record: GM clicks the badge at the top of the screen → *Start session*. Players accept the consent dialog
   (asked once per account). Anyone: **Alt+Shift+F** marks a friction moment. GM → *Stop session*.
4. Investigate (Node ≥ 22.13, no npm dependencies) on a copy of that folder:

```bash
rsync -a foundry-host:/path/to/Data/flight-recorder/ ./ffr-storage/
export FFR_DB=./data/ffr.db
npm run -s ffr -- import ./ffr-storage
npm run -s ffr -- sessions
npm run -s ffr -- digest latest --out /tmp/digest.json
npm run -s ffr -- around latest --event <id> --before 30s
codex "Investigate the latest recorded session and write the report"   # uses the investigate-session skill
```

UI in English and French (follows the Foundry language). Details: [docs/deployment.md](docs/deployment.md).

Try it without Foundry: `npm run -s fixtures -- --db /tmp/fx.db` generates two synthetic PF2e sessions
(targeting struggle, injected module error, freeze, disconnect, config change between sessions).

## Documentation

| | |
|---|---|
| [AGENTS.md](AGENTS.md) | working on the code: conventions, tests, releases |
| [investigate-session skill](.agents/skills/investigate-session/SKILL.md) | investigation workflow and grounding rules for Codex / Claude |
| [docs/deployment.md](docs/deployment.md) | module setup, where recordings go, recording, import |
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
npm test                 # node:test: schema, recorder, storage, hooks, analysis on synthetic sessions
flock /tmp/maxi.lock npm run e2e   # real Foundry run (needs a local licensed Foundry + Playwright)
```

Layout: `packages/schema` (shared), `packages/foundry-module`, `packages/analysis-cli`, `tests/`, `docs/`.
