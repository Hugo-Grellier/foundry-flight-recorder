# Privacy, consent and security

The recorder collects behavioural telemetry. Defaults are chosen so a GM can run it at a table of
friends without surprising anyone.

## Consent model

1. Nothing is recorded unless the GM enables the recorder **and** starts a session.
2. Each participant decides for their own browser (`Configure Settings → Flight Recorder → My participation`):
   *Ask me* (default: a dialog appears when a recording starts), *Yes*, *No*. Declining drops every
   buffered event and sends nothing.
3. Before consent, events are held in memory only (never sent, never written to disk) and discarded on refusal.
4. A badge at the top of the screen shows the state to everyone: `● REC`, `○ REC (not you)`, `○ rec off`.
   Clicking it lets anyone stop recording their client or report friction.
5. The GM's client records some events about others (chat message metadata, combat turns, connections).
   Players are told this in the consent text.

## What is never collected

Chat message content, typed text or input values, password fields, keystrokes, clipboard, journal/notes
content, HTML of anything, HTTP bodies, cookies or tokens, audio, screenshots. `ui.focus` records only the
field's `name` attribute and kind. Friction notes are the only free text and are typed explicitly for the GM.

## Minimization

- Pseudonyms: `u_<hash(worldId:userId)>`; no user names. (Pseudonymous, not anonymous: the GM can recompute it.)
- Entity names (actors, items, scenes, windows) only with the world setting *Record entity names* (default on;
  turn off for ids/types only).
- Settings snapshot: only Boolean/Number settings and String settings with enumerated choices, of core,
  the system and active modules, excluding user-scoped settings and keys matching
  `key|token|secret|passw|auth|api|webhook|url|uri|email|license|credential|host|server|endpoint`.
- Sanitization (client and server): drops keys like `password`, `apiKey`, `authorization`, `cookie`,
  `content`, `html`, `text`, `body`, `license`; scrubs JWTs, bearer tokens, emails, IPv4 addresses,
  secret-looking URL query parameters; bounds depth, array and string sizes.

## Security

- The ingest key is visible to every connected browser (it is a world setting). It can only append events.
  There is no HTTP endpoint to read, export, delete or configure anything.
- Administration = shell access to the collector host: `ffr` (or `docker compose exec collector node packages/analysis-cli/ffr.mjs`).
- Collector controls: exact Origin allowlist, key check (constant time), 512 KiB body limit, 500 events per
  batch, per-IP request rate, per-client event rate, storage cap (HTTP 507), strict schema validation.
- Store the database outside Foundry's `Data` directory (Foundry serves `Data` publicly).
- Client-supplied events are untrusted: the user pseudonym and role are claims, not authentication.
  Anyone holding the ingest key can append garbage to a session; they cannot read anything.
- Telemetry text is untrusted input for Codex (see AGENTS.md "Grounding rules").

## Retention and deletion

- `FFR_RETENTION_DAYS` (default 180): sessions older than this are deleted hourly-ish by the collector.
- `ffr delete <session> --yes`, `ffr delete-user <u_pseudo> --yes`, `ffr retention --days N --yes`.
- A participant can ask the GM for deletion; the GM finds the pseudonym in `ffr info` (role, client times).
- `ffr export <session>` gives the full data of a session (JSONL).
