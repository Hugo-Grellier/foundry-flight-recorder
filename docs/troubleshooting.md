# Troubleshooting

| Symptom | Check / fix |
|---|---|
| Badge shows `○ rec off` | GM has not enabled the recorder or started a session. |
| Badge `○ REC (not you)` | This client's participation is *No* (or the consent dialog was dismissed): badge → *Record my client*. |
| Badge menu: "Storage: failing (no GM online or network)" | The player has no *Upload Files* permission and no GM is connected: batches wait in memory and are written when a GM joins. Or the network to Foundry is down. |
| Badge menu: "Storage: failing (403)" | The user lost *Upload Files* mid-session; batches refused with 4xx are dropped (no retry loop). |
| Badge menu: "Storage: failing (500)" | Foundry refused the upload (disk full, `Data/flight-recorder` not writable): check the Foundry server log. |
| No files in `Data/flight-recorder/` | Recorder not enabled, no session started, or nobody consented. Each participant has a folder per session. |
| Module not listed in Foundry | Restart Foundry after copying into `Data/modules`. |
| `ffr: database not found` | Run `ffr import <copy of Data/flight-recorder>` first, or pass `--db` / `FFR_DB`. |
| `ffr import` lists `invalidFiles` | Files edited by hand, a participant/folder mismatch or a reused client id: refused on purpose (see privacy.md). |
| Clock skew looks wrong after import | The copy lost file modification times: copy with `rsync -a` or `cp -p`. |
| Session still `active` | GM closed the tab without *Stop session*: `ffr finalize <s>`. |
| `rec.loss` events / `seqMissing` | Client queue overflowed (storage unreachable for several minutes at high event rates) or rate-limited types; see `ffr info`. |
| No `perf.loaf` / `longTasks` | Browser lacks Long Animation Frames (Firefox/Safari); frame times are still measured. |
| ExperimentalWarning about SQLite | Harmless (`node:sqlite`); npm scripts suppress it. |
| Console shows errors from `foundry-flight-recorder` | Should not happen: handlers are wrapped. `api.status().selfErrors` counts swallowed internal errors; please report with the session id. Our hook wrappers do appear in the stacks of other modules' hook errors (and in libWrapper's `[Detected packages]` note): that is not our error. |
