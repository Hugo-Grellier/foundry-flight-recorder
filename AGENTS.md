# AGENTS.md

Foundry Flight Recorder: a Foundry VTT V14 module (PF2e-aware) that records consenting participants'
sessions as JSON files on the Foundry server, and `ffr`, a CLI that imports them into SQLite and analyses
them. Architecture and decisions: [`docs/architecture.md`](docs/architecture.md).

**Investigating a recorded session or writing its report:** follow the `investigate-session` skill,
[`.agents/skills/investigate-session/SKILL.md`](.agents/skills/investigate-session/SKILL.md).

## Working on the code

- Node ≥ 22.13, zero npm dependencies, plain ES modules, no bundler. `npm test` runs every suite;
  `npm run build` produces `dist/foundry-flight-recorder(.zip)`.
- `packages/foundry-module/scripts/schema.mjs` is a symlink to `packages/schema/schema.mjs` (shared by the
  module and the CLI); edit the latter. The build materializes the symlink.
- Logic takes its Foundry dependencies as injected functions (`Recorder` transport and timers, `FoundryStore`
  upload/socket, `installHookProfiler` Hooks), so it runs under `node:test`. Keep the Foundry glue in
  `main.mjs` / `capture.mjs` thin and put behaviour where a test can reach it.
- Verify every Foundry or PF2e API against the shipped source (client `scripts/foundry.mjs`, server `dist/`,
  PF2e `pf2e.mjs`) before relying on it, and record it under "integration points" in the architecture doc.
- Capture is passive: hook handlers are wrapped in `safe()` and return nothing, so they never veto. The only
  wrappers are the ones listed in ADR 10; adding one is a design decision to discuss first.
- Privacy is a hard rule: chat content, typed text, journal content, HTML and credentials are never
  recorded. A new event type goes into `EVENT_TYPES` (schema), `docs/telemetry-schema.md`, and, if it
  carries data about people, `docs/privacy.md`. A new analysis behaviour or caveat goes into the skill.
- UI strings exist in English and French (`lang/en.json`, `lang/fr.json`); a test checks key coverage.
- Each non-trivial change leaves a test that fails without it; check that by breaking the code once.

## Runtime testing

- `npm run e2e` drives a real licensed Foundry (shared lab instance): run it only when the lab owner allows
  it, under `flock /tmp/maxi.lock`. It restores the world and deletes its recordings afterwards.
- Never install on, restart or test against a production Foundry without the owner's explicit approval
  for that exact action.

## Releasing

Bump the version in `packages/foundry-module/module.json`, `package.json` and `RECORDER_VERSION`
(`packages/foundry-module/scripts/recorder.mjs`), push, then publish a GitHub release tagged `vX.Y.Z`:
`.github/workflows/release.yml` runs the tests and attaches `module.json` + `module.zip`. A change to the
storage layout or settings is a minor bump, with a **Breaking** line in the release notes.
