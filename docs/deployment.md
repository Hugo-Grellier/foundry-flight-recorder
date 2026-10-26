# Deployment

## 0. Default: no collector

Install the module (manifest URL
`https://github.com/Hugo-Grellier/foundry-flight-recorder/releases/latest/download/module.json`), enable it,
tick *Enable* and leave *Collector ingest URL* empty. Recordings are written as JSON files on the Foundry
server, in `Data/modules/foundry-flight-recorder/storage/<world>/<session>/` (module persistent storage:
kept across module updates).

- Players with the *Upload Files* permission write their own files: they keep recording while no GM is
  connected (as long as a session is started).
- Other players send to the connected GM, who writes for them. Without a GM online their events wait in
  memory (bounded queue) and in the browser's storage at page close, and are sent when a GM connects.
- One file per batch (every 15 s, sooner after an error/freeze/friction).

Analysis: copy the folder to your machine keeping modification times (they are the server's receive times,
used to correct client clock skew), then import it:

```bash
rsync -a foundry:/path/to/Data/modules/foundry-flight-recorder/storage/ ./ffr-storage/
npm run -s ffr -- import ./ffr-storage --db ./data/ffr.db    # idempotent: re-import after each session
```

Privacy trade-offs of this mode: [privacy.md](privacy.md#default-storage-files-on-the-foundry-server).
Use the collector (below) for a central database, retention and stricter privacy.

## 1. Collector (optional)

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
Traefik (file provider): a router `Host(\`foundry.example\`) && PathPrefix(\`/ffr/\`)` (outranks the Foundry
router, longer rule) with a `stripPrefix: {prefixes: [/ffr]}` middleware. Serving the collector under the Foundry
origin makes ingest same-origin for every player: no CORS, no mixed content, no Chrome local-network prompt.
Leave `FFR_TRUST_PROXY=0` when the first `X-Forwarded-For` entry can be client-supplied (e.g. behind Cloudflare):
all clients then share the proxy's IP bucket (10 batches/s, burst 40), plenty for a table.

LAN over plain HTTP works (`http://<host>:4318/v1/ingest`, publish the port on the LAN interface) but
keys and telemetry travel unencrypted.

## 3. Foundry module

```bash
npm run build                                   # dist/foundry-flight-recorder/ and .zip
node scripts/build-module.mjs --install /path/to/FoundryData/Data/modules
```

Restart Foundry (new packages are discovered at startup), enable *Flight Recorder* in the world, then in
*Configure Settings → Flight Recorder*: enable, collector URL (empty = files on the Foundry server),
ingest key (collector only), mode, entity names.

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
