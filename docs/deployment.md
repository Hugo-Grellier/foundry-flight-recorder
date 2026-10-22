# Deployment

## 1. Collector

```bash
cp .env.example .env            # set FFR_INGEST_KEY (openssl rand -hex 24) and FFR_ALLOWED_ORIGINS
docker compose -f docker/compose.yml --env-file .env up -d --build
curl -s http://127.0.0.1:4318/healthz
```

Without Docker (Node ≥ 22.13): `FFR_INGEST_KEY=... FFR_ALLOWED_ORIGINS=... FFR_DB=./data/ffr.db npm run collector`.

| Variable | Default | Meaning |
|---|---|---|
| `FFR_INGEST_KEY` | — (required) | append-only key, copied into the module settings |
| `FFR_ALLOWED_ORIGINS` | — | exact browser origins of Foundry, comma separated (`*` only for tests) |
| `FFR_HOST` / `FFR_PORT` | 127.0.0.1 / 4318 | listen address (container: 0.0.0.0) |
| `FFR_DB` | ./data/ffr.db | SQLite file (container: /data/ffr.db) |
| `FFR_RETENTION_DAYS` | 180 | 0 disables automatic deletion |
| `FFR_MAX_DB_MB` | 2048 | refuse ingestion (507) above this size |
| `FFR_SESSION_IDLE_MIN` | 240 | sessions without traffic are marked ended |
| `FFR_RATE_RPS` / `FFR_RATE_EPM` | 10 / 6000 | per-IP batches/s, per-client events/min |
| `FFR_TRUST_PROXY` | 0 | use `X-Forwarded-For` for rate limiting |

## 2. Reverse proxy / HTTPS

Browsers block HTTP requests from an HTTPS page (mixed content). If Foundry is served over HTTPS, serve the
collector over HTTPS too, ideally on the same host under a path:

```nginx
# inside the Foundry server { } block
location /ffr/ {
    proxy_pass http://127.0.0.1:4318/;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    client_max_body_size 1m;
}
```

Endpoint in the module: `https://foundry.example.org/ffr/v1/ingest`, `FFR_ALLOWED_ORIGINS=https://foundry.example.org`,
`FFR_TRUST_PROXY=1`. Caddy: `handle_path /ffr/* { reverse_proxy 127.0.0.1:4318 }`.

LAN over plain HTTP works (`http://<host>:4318/v1/ingest`, publish the port on the LAN interface) but
keys and telemetry travel unencrypted.

## 3. Foundry module

```bash
npm run build                                   # dist/foundry-flight-recorder/ and .zip
node scripts/build-module.mjs --install /path/to/FoundryData/Data/modules
```

Restart Foundry (new packages are discovered at startup), enable *Flight Recorder* in the world, then in
*Configure Settings → Flight Recorder*: enable, collector URL, ingest key, mode, entity names.

## 4. Recording a session

GM: click the `○ rec off` badge (top centre) → *Start session* → optional label. Players get the consent
dialog (or their saved choice). During play anyone can press **Alt+Shift+F** (or click the badge) to mark
friction. GM: badge → *Stop session* at the end (otherwise the collector marks it ended after
`FFR_SESSION_IDLE_MIN`). Macro API: `game.modules.get("foundry-flight-recorder").api` →
`start(label)`, `stop()`, `mark(cat, note)`, `status()`.

## 5. Investigating

On the collector host: `FFR_DB=./data/ffr.db npm run -s ffr -- digest latest`, or open the repo in Codex and
ask it to investigate the latest session following AGENTS.md. In Docker:
`docker compose -f docker/compose.yml exec collector node packages/analysis-cli/ffr.mjs sessions`
(or copy `data/ffr.db` to your workstation; the DB is a single file — stop the collector or use
`sqlite3 ffr.db ".backup copy.db"` for a consistent copy).
