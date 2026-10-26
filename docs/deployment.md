# Deployment

Nothing to run besides Foundry: recordings are written by Foundry itself, and analysed on a copy.

## 1. Install the module

In Foundry: *Add-on Modules → Install Module*, Manifest URL
`https://github.com/Hugo-Grellier/foundry-flight-recorder/releases/latest/download/module.json`.

Or build it yourself:

```bash
npm run build                                   # dist/foundry-flight-recorder/ and .zip
node scripts/build-module.mjs --install /path/to/FoundryData/Data/modules
```

Restart Foundry if you copied the files by hand (new packages are discovered at startup).

## 2. Configure the world

Enable *Flight Recorder* in the world, then *Configure Settings → Flight Recorder*: **Enable**, mode, entity
names. Mode *diagnostic* also times every hook listener per package (`ffr perf`); it suspends itself above
2 % overhead. Keep it off for performance measurements.

Recordings are JSON files on the Foundry server, one per batch (every 15 s, sooner after an
error/freeze/friction), in `Data/flight-recorder/<world>/<session>/<participant>/`. Module updates never
touch that folder.

- Players with the *Upload Files* permission write their own files: they keep recording while no GM is
  connected (as long as a session is started).
- Other players send to the connected GM, who writes for them. Without a GM online their events wait in
  memory (bounded queue) and in the browser's storage at page close, and are written when a GM connects.

Privacy trade-offs: [privacy.md](privacy.md#security).

## 3. Recording a session

GM: click the `○ rec off` badge (top centre) → *Start session* → optional label. Players get the consent
dialog once per account (or their saved choice). During play anyone can press **Alt+Shift+F** (or click the
badge) to mark friction. GM: badge → *Stop session* at the end (otherwise `ffr finalize <s>` after import).
Macro API: `game.modules.get("foundry-flight-recorder").api` → `start(label)`, `stop()`, `mark(cat, note)`,
`status()`.

## 4. Investigating

Copy the recordings to your machine keeping modification times (they are the server's write times, used to
correct client clock skew), then import them (Node ≥ 22.13, no npm dependency):

```bash
rsync -a foundry-host:/path/to/Data/flight-recorder/ ./ffr-storage/
export FFR_DB=./data/ffr.db
npm run -s ffr -- import ./ffr-storage        # idempotent: re-run after each session
npm run -s ffr -- digest latest
```

Then open the repo in Codex or Claude Code and ask it to investigate the latest session: the
`investigate-session` skill drives the analysis.
