# Vault hub (v3)

`server/hub/hub.ts` owns one vault's file metadata and ordered change log.
The vault folder is the only content store. `hub.sqlite` in the configured
state directory stores hashes, sizes, mtimes, vectors and change metadata,
never note contents or previous versions. It uses `node:sqlite`, WAL, and
schema version 2 (version 1 migrates in place). Peers are `local` (outside programs) and `globnotes`
(managed writes, with `api` or `plugin:<id>` origin detail).

## Observations

`start()` does a full scan and starts a recursive filesystem watcher plus
a periodic full scan. `GLOBNOTES_HUB_SCAN_INTERVAL` is read once per hub
(seconds, positive, default 60). Watch events debounce for 300 ms and scan
affected directories; they are hints, not the source of truth. A failed
watcher leaves periodic scans active. Scans are synchronous and serialized
with the synchronous managed storage effects/recording on the server thread.
`scanNow()` is an in-process test seam, not an HTTP endpoint.

Dot folders and all file types are included, except the canonical host state
directory (including hub DB/WAL files). Symlinks are counted but not followed.
Unchanged size+mtime skips hashing; SHA-256 is streamed otherwise. Unreadable
subtrees are unknown, never interpreted as deletion. Only an unambiguous
one-source/one-destination content-hash match in a scan is a rename.

Paths are vault-relative, `/`-separated, case-sensitive and compared as NFC.
Real disk spelling is retained. NFC collisions are reported through
`collisions()` and warned once per key; one selected file is tracked, without
merging, renaming or changing disk files.

A configured vault root may be a symlink. `relativePath()` maps both that spelling
and the real root into the same vault coordinates for expected paths, actual
journals, watcher hints and operation facts. Descendant symlinks are still skipped.

## Managed effects

`NoteOperations` announces canonical paths with `expect()` immediately before
storage effects. `expect()` first synchronously reconciles those file paths and
directory descendants through the ordinary scanner, then reserves them. Previously
unobserved outside creates/modifications/deletions therefore enter the log as
`local`, with their own sequence and vector increment, before the managed effect.
These local observations also reach the existing external-fact projection.
There is no parallel before-metadata path or synthetic vector seed.
Its existing effect journal supplies `record()` in `finally`,
including completed effects preceding a partial failure. Repeated writes and
rename+write are folded into the final file observation. Directories are not
tracked; known descendants of attachment directory moves are recorded as file
renames. A globnotes write increments its vector dimension and never echoes
back as a local change on the next scan. Callers must always settle expectations,
including a no-effect failure. This does not change save semantics or provide
filesystem CAS against outside programs.

If actual storage effects occurred but hub reconciliation cannot be verified,
the operation reports `operation_partial` rather than acknowledging an unrecorded
version as success. The public HTTP error's `partial` object contains
`completedPaths` and an optional `failedPath`; detailed storage-effect journals
are attached to lifecycle fact metadata instead.

Derived projections are isolated per entry: a failed index update or fact read
is logged without dropping the remaining entries and their sync boundary.

## Write gate

`server/hub/gate.ts` is the only way globnotes changes the vault folder.
`server/hub/effects.ts` performs every filesystem mutation on a vault (and on
plugin-granted roots outside it); a vault target needs a live gate pass naming
it, or a directory on the route to one (missing parents, pruned empty ones), and
fails with `UngatedVaultWrite` otherwise. `HubGate.apply(paths, origin, journal,
effect)` announces the paths (`expect`), opens the pass only for the
synchronous effect, and records the journaled effects with their origin
(`api`, `plugin:<id>`) in `finally`, including completed effects before a
failure. Callers run it inside their short commit section after revalidating
what they checked. Note operations, uploads and the plugin filesystem facade
all use it, so facade writes are `globnotes` changes with the plugin's origin.

Staging files (`.globnotes-staging-<uuid>` in the target folder) are not vault
content: the scanner skips that reserved name and publication records only the
target. A file's version is the SHA-256 of its raw bytes, the hub's `hash`;
note responses compute it from the bytes read with the content
(`versionOf`, `noteVersion` in `server/hub/merge.ts`).

Moves never replace: a note rename refuses an occupied destination, and an
attachment moved with its note (`file_refs=move`) onto a taken name gets the next
free macOS-style name (`name 1.ext`, `name 2.ext`, ...), the note's link is
rewritten to it (percent-encoded, so it stays a valid Markdown link), and the
response's `movedFiles` entry carries `renamed: true`.

## Versioning

Versioning is plugins, not hub (decision row 17). Before the gate replaces,
deletes or moves bytes away from a path, `HubGate.offer()` hands them to
versioners through `server/hub/versioning.ts`; the plugin runtime implements
it. Offers are `{operationId, kind: replace|delete|move, path, newPath?,
version, size, bytes, origin}`: note saves (also with identical content),
merges (the current file), deletes, renames (the note and each moved
attachment), reference rewrites, plugin file writes and plugin facade
replace/rename/remove in the vault. Creates, uploads and conflict copies
displace nothing. Files over 16 MiB are offered with `bytes: null`.

Offers run after guards and outside every write lock; the commit then
revalidates that the offered bytes are still the ones displaced, so a refusal
there means the versioner kept a version that was not replaced. Each versioner
gets `versioningMs` (10 s, observed time), counted from when the offer starts
(after the guards, never shortened by them), in its own bounded lane to take
custody; a failure, decline or timeout lets the write proceed and is visible
in the plugin's diagnostics and the operation's fact metadata
`versioning: [{pluginId, path, status}]`. The custody window is soft: a handler
still running at its end counts as `timeout` but keeps running under the
ordinary service-call bound, and the plugin stays ready; an offer still queued
at its end is withdrawn without running. A moved attachment directory offers
each regular file below it (symlinks are not followed). Writes by a versioning plugin are
never offered (its storage writes would wait on itself). The hub keeps none
of the bytes. Changes by outside programs are already on disk when observed
and cannot be offered.

The contract rule `single-vault-writer` (`tests/test_isolation_contract_test.ts`)
rejects filesystem mutations under `server/` outside `effects.ts`; the remaining
listed lines write only the canonical state directory or the client build.

## Retention and consumers

Deletion removes the live file row, leaves an HMAC-SHA256 NFC path key with
its vector in `tombstones`, and nulls matching plaintext paths throughout the
log in the same transaction. `secure_delete=ON` and a truncating WAL checkpoint
after scrubbing remove freed plaintext database pages. A recreated file starts
above the tombstone vector and removes that tombstone. This guarantee applies
to the hub database, not copies maintained independently by other tools.

`changesSince(cursor)` returns ordered entries or `gap: true` when the cursor
predates retained history. The newest 100,000 entries are retained.
`subscribe(callback)` returns a disposer. Committed batches are delivered
synchronously, with failing subscribers isolated. Live deletion notifications
carry the path for consumers; the persisted log has only its anonymous key.
The hub retains no content for replay.

At startup `main.ts` inventories the vault before admitting subscribers, then
starts the existing background index rebuild. `server/hub/subscribers.ts`
contains two ordered projections: the FTS5 subscriber first updates `.md`
entries (including delete-old/reindex-new on rename), then the external-facts
subscriber preserves existing local `on-create`/`on-save`/`on-delete` and one
noninitial sync per changed scan batch. An outside rename remains a delete plus
create for these legacy hooks. Managed-peer batches are ignored by that second
subscriber. No new hook kinds or driver APIs are introduced in M1.

Search and tag queries read the index without a filesystem scan. The index's
initial build remains available for rebuilds. An own save's hub commit and index
notification complete synchronously before the operation's lifecycle facts and
return, including reconciliation of actual partial effects.

## Base-aware editor saves (M2)

Note updates may send `baseContent` alongside `newContent`. Under the existing
note lock, an equal base writes normally; a stale base receives a request-local,
line-based three-way merge (`node-diff3`, MIT). Clean merges preserve the current
file's line ending. Neither the base nor any patch is persisted in the hub.
The existing guard/commit revalidation still rejects changes during guard waits;
this is not filesystem CAS against outside programs.

Overlapping edits leave the original untouched and create the submitted text
next to it as `<stem>.conflict-YYYYMMDD-HHMMSS-globnotes.md` (UTC), using the normal
guarded, create-exclusive path. Occupied names receive `-2`, `-3`, etc. before
`.md`. No requested rename is applied on conflict. A missing original is
recreated through guarded creation. Cancellation/failure retains existing error
semantics.

## Bases

No globnotes writer replaces, renames or deletes without stating its base, the
same parameter for every write: `{kind:"absent"}`, `{kind:"version", version}`
(SHA-256 of the bytes read) or `{kind:"text", content}` for notes (the editor's
`baseContent` is this form). Without one: `428 base_required`, nothing written.

| # | Writer | Base | Stale base |
|---|---|---|---|
| 1 | Note update (content) | Version or text | Text merges when it can; otherwise `onStale`: `copy` (default) keeps the writer's text as a conflict copy, `refuse` answers `409 base_stale` with `currentVersion` |
| 2 | Note rename (with or without content) | Version or text | Refused (`base_stale`) |
| 3 | Note delete | Version (`DELETE ...?base_version=<hex>`) | Refused; nothing deleted |
| 4 | Create, upload, conflict copy | Implicit absent | Create: `note_exists`; upload: a time-suffixed free name |
| 5 | Plugin `file-write` | Absent or version | Notes as rows 1-2; other files are binary and never merge (copy `<stem>.conflict-...-globnotes.<ext>` or refuse); outside the vault always refused |
| 6 | Reference rewrite, link rebasing, H1 sync | The host's own read under the lock | `operation_conflict`, nothing written |
| 7 | Plugin filesystem facade | Its tokens (`expect`, `sourceToken`, `token`) | `fs_conflict` |
| 8 | MCP update/delete | `expected_last_modified` and/or `expected_hash`, one required | Refused with an actionable message |

`tests/hub_gate_contract_test.ts` holds the registry of every writer with its base
and stale outcome and fails when code gains a writer the registry does not list.

GET/save responses include `version`, the SHA-256 of the returned content;
updates add `saveResult: {status: saved|merged|conflict, conflictCopyPath?,
recreated?}`. A conflict response describes the copy, not the original.
`hub.recordConflict()` and `hub.conflicts()` own metadata-only conflict records
(vault-relative paths including extensions). Deleting either member closes the
record and nulls both plaintext paths in the deletion transaction, with the same
secure-delete/checkpoint policy as the change log. Anonymous path keys remain.

## Browser changes

`GET /_/api/changes` with `Accept: text/event-stream` emits `change` frames
with a sequence `id` and `{seq,path,kind,oldPath?,hash?,peer}`. Resume through
`Last-Event-ID` or `?since=N`. Comment heartbeats run every 25 seconds (`CHANGE_STREAM_HEARTBEAT_MS` in
`shared/vault_changes.ts`).
`?since=N&poll=1` returns `{entries,next}` or `{gap:true,next}`. Cursors older
than retained history, cursors beyond the current log, and replay containing
anonymous deleted names require a snapshot reset. Live deletion frames retain
their transient path. Neither transport discloses anonymous keys or origins.

Read authorization is the same as note reads, rechecked before stream emissions
and heartbeats; expiry and policy changes close streams. Each connection owns
one hub subscription, disposed on disconnect. Hidden paths, reserved app paths,
canonical state and paths outside the ordinary note/file read namespace are
filtered. Renames crossing that boundary disclose only the visible side.
`client/vaultChanges.js` is the single reference-counted connection owner,
publishes bus facts and resumes its cursor. Its reconnect rule:

| # | Outcome | Next |
|---|---|---|
| 1 | 400, 401, 403, 404, 405, 410, 501 (auth, endpoint missing, request rejected) | Stop; a later lifecycle start retries (the page shown again after 10 s hidden or restored from history, or a new first owner) |
| 2 | Anything else: network error, 408, 429, 5xx (a proxy's 503 during a restart) | Retry after 0.5 s, doubling to at most 30 s |
| 3 | A stream that stayed open 30 s ends or breaks | The backoff starts over (a proxy idle timeout is not a fault) |
| 4 | A stream breaks, or no stream could be opened | JSON polling once a second; the stream is tried again after 60 s of polling |
| 5 | The tab is hidden for 10 s | The stream is closed; when shown, it reconnects and catches up from its cursor |
| 6 | A request, stream or poll, receives no bytes for 75 s (`CHANGE_STREAM_STALL_MS`, 3 heartbeats; a half-open connection or a buffering proxy). Bodies are read chunk by chunk and every chunk counts, so a slow poll that keeps arriving is not a stall | It is aborted as a failure: rows 2-4 apply, so a stalled stream falls back to polling |

Row 5 keeps open streams to visible tabs: on plain HTTP each stream holds one of
the browser's few HTTP/1.1 connections per host, shared by all tabs.
`client/api.js` owns fetch streaming and the JSON polling fallback.
