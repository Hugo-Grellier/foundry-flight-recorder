# Troubleshooting

| Symptom | Check / fix |
|---|---|
| Badge shows `○ rec off` | GM has not enabled the recorder or started a session. |
| Badge `○ REC (not you)` | This client's participation is *No* (or the consent dialog was dismissed): badge → *Record my client*. |
| Badge menu: "Collector: failing (HTTP 0)" | Network/CORS/mixed content. Open devtools Network tab: blocked = mixed content (use HTTPS endpoint); CORS error = origin not in `FFR_ALLOWED_ORIGINS` (must match scheme+host+port exactly). |
| HTTP 401 | Ingest key in module settings ≠ `FFR_INGEST_KEY`. Batches refused with 4xx are dropped (no retry loop): fix and new events flow. |
| HTTP 400 | Schema mismatch (module and collector versions differ). Rebuild both from the same commit. |
| HTTP 429 | Rate limits; raise `FFR_RATE_RPS`/`FFR_RATE_EPM` for big tables or diagnostic mode. Client retries with backoff. |
| HTTP 507 | `FFR_MAX_DB_MB` reached: export/delete old sessions or raise the cap. |
| Module not listed in Foundry | Restart Foundry after copying into `Data/modules`. |
| `ffr: database not found` | Pass `--db` or `FFR_DB`; in Docker the DB is `/data/ffr.db` in the container. |
| Session still `active` | GM closed the tab without *Stop session*: `ffr finalize <s>` or wait `FFR_SESSION_IDLE_MIN`. |
| `rec.loss` events / `seqMissing` | Client queue overflowed (collector unreachable > ~a few minutes at high event rates) or rate-limited types; see `ffr info`. |
| No `perf.loaf` / `longTasks` | Browser lacks Long Animation Frames (Firefox/Safari); frame times are still measured. |
| ExperimentalWarning about SQLite | Harmless (`node:sqlite`); npm scripts and the Docker image suppress it. |
| Console shows errors from `foundry-flight-recorder` | Should not happen: handlers are wrapped. `api.status().selfErrors` counts swallowed internal errors; please report with the session id. |
