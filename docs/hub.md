# Vault hub (v3, M1)

`server/hub/hub.ts` owns one vault's file metadata and ordered change log.
The vault folder is the only content store. `hub.sqlite` in the configured
state directory stores hashes, sizes, mtimes, vectors and change metadata,
never note contents or previous versions. It uses `node:sqlite`, WAL, and
schema version 1. Peers are `local` (outside programs) and `globnotes`
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

Auxiliary plugin filesystem publication still has separate write/rename/remove/
mkdir branches and asynchronous temporary-file preparation. M1 leaves those
writes to local observation; M4 routes the remaining writers through the gate.

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
