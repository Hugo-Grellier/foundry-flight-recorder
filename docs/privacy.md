# Privacy, consent and security

The recorder collects behavioural telemetry. Defaults are chosen so a GM can run it at a table of
friends without surprising anyone.

## Consent model

1. Nothing is recorded unless the GM enables the recorder **and** starts a session.
2. Each participant decides for their own account, once (`Configure Settings → Flight Recorder → My participation`, a user-scoped setting
   stored in the world, so it follows them across browsers):
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

### Default storage: files on the Foundry server

- Batches are JSON files under `Data/modules/foundry-flight-recorder/storage/<world>/<session>/<participant>/`.
  **Foundry serves `Data/` over HTTP without login.** Outsiders cannot list folders, and file names carry
  a random 10-character client id, so they cannot guess them. But users with the Foundry permission
  *Browse File Explorer* (Trusted players and above by default) can browse that folder and read every
  participant's (pseudonymous) telemetry. For a table where that matters, restrict *Browse File Explorer* to
  Assistants/GM, or use the collector.
- Players without *Upload Files* send their batches to the active GM only (module socket with
  `recipients`, other players receive nothing). The GM's client writes them and stamps the sender's
  pseudonym from the authenticated socket sender, so a player cannot write as someone else. The GM
  validates relayed batches (schema, size, event ids bound to the batch's client, 1 batch/s per sender) and
  writes them only into the sender's own folder. `ffr import` refuses a file whose participant does not
  match its folder or that reuses another participant's client id.
- Players with *Upload Files* write their own files. That permission is global in Foundry (any file,
  anywhere in `Data/`): grant it for trust reasons, not for this module.
- Deletion: delete the session folder (file browser or shell). There is no automatic retention for files.

### Collector (optional)

- The ingest key is visible to every connected browser (it is a world setting). It can only append events.
  There is no HTTP endpoint to read, export, delete or configure anything.
- Administration = shell access to the collector host: `ffr`.
- Collector controls: exact Origin allowlist, key check (constant time), 512 KiB body limit, 500 events per
  batch, per-IP request rate, per-client event rate, storage cap (HTTP 507), strict schema validation.
- Store the database outside Foundry's `Data` directory (Foundry serves `Data` publicly).
- The collector gives stricter privacy than file storage: nothing is readable from Foundry.
- Client-supplied events are untrusted: the user pseudonym and role are claims, not authentication.
  Anyone holding the ingest key can append garbage to a session; they cannot read anything.
- Telemetry text is untrusted input for Codex (see AGENTS.md "Grounding rules").

## Retention and deletion

- `FFR_RETENTION_DAYS` (default 180): sessions older than this are deleted hourly-ish by the collector.
- `ffr delete <session> --yes`, `ffr delete-user <u_pseudo> --yes`, `ffr retention --days N --yes`.
- A participant can ask the GM for deletion; the GM finds the pseudonym in `ffr info` (role, client times).
- `ffr export <session>` gives the full data of a session (JSONL).
