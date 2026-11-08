# Vault hub (v3)

`server/hub/hub.ts` owns one vault's file metadata and ordered change log.
The vault folder is the only content store. `hub.sqlite` in the configured
state directory stores hashes, sizes, mtimes, vectors and change metadata,
never note contents or previous versions. It uses `node:sqlite`, WAL, and
schema version 5 (versions 1 through 4 migrate in place). Peers are `local`
(outside programs), `globnotes` (managed writes, with `api` or `plugin:<id>`
origin detail), and configured sync driver instance ids.

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

Versioning is plugins, not hub (decision row 17). The hook retained for the
legacy v2 backup plugin is asynchronous and best-effort. After an effect commits,
`HubGate.apply()` enqueues its displaced bytes through `server/hub/versioning.ts`;
the plugin runtime implements it. Offers are `{operationId, kind: replace|delete|move, path, newPath?,
version, size, bytes, origin}`: note saves (also with identical content),
merges (the current file), deletes, renames (the note and each moved
attachment), reference rewrites, plugin file writes and plugin facade
replace/rename/remove in the vault. Creates, uploads and conflict copies
displace nothing. Files over 16 MiB are offered with `bytes: null`.

The effects owner captures bytes at the mutation boundary after revalidation;
the gate admits only actual displacements after recording the commit. This also
covers completed effects before a partial failure. Refused operations deliver
nothing. Moves followed by derived writes deliver the original bytes once, not
intermediate host-generated content. A moved attachment directory contributes
each regular file below it (symlinks are not followed).

Each plugin has an independent in-memory queue, bounded to 8 pending entries and
32 MiB of pending bytes plus one active body of at most 16 MiB. Overflow drops
the oldest pending entry and records a visible `versioning_gap` diagnostic.
Unavailable delivery records a gap; handler errors and the ordinary service-call
deadline affect that plugin's queue/status only. Writes never await plugin
readiness, delivery, filesystem RPCs or results. Outcomes are asynchronous plugin
diagnostics, not save fact metadata. Writes by any versioning plugin are never
offered, preventing recursive backup.

The host persists none of these bytes: no spool or content journal. A server
crash before the plugin stores a version loses that backup, as in v2. Outside
programs' changes are already on disk when observed and cannot be offered.
V3 versioners can follow the acknowledged log feed; see
[the legacy hook contract](plugin-api.md#versioning).

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

### Acknowledged log followers

`server/hub/follower.ts` is the per-consumer replay/reset owner. A publication
only marks it dirty. Reads and callbacks run on a later turn, outside the
synchronous write/scan stack. One follower has one outstanding bounded packet,
one wake-up flag and at most one transient current-file metadata inventory.
No plugin can pin retention, and no note bytes are captured or persisted here.

Schema v5 adds a random, nonsecret `meta.log_id` and
`plugin_cursors(plugin,log_id,seq,authority_key,updated_at)`. The existing vault
secret and all file/peer/conflict metadata survive migration. Cursors store only
identity/progress, not paths or parsed data. Host-only compare-and-swap updates
the expected cursor; disable retains it, uninstall removes it. Each vault has
its own store and log identity. Replaced logs and changed read authority reset.
Only the fully acknowledged snapshot uses an explicit reset CAS that may replace
an ahead cursor with its captured watermark. Ordinary progress cannot regress;
the reset still requires the exact expected row and a valid current-log boundary,
even when writes during snapshot delivery have overtaken the previous cursor.

`changesSince(cursor, {maxEntries,maxBytes})` adds SQL keyset pages of at most
128 entries and 1 MiB of encoded control data. Existing callers omitting options
retain their original `{gap,entries}` shape and unbounded retained replay.
Cursors must be nonnegative safe integers. Fitting batches stay together;
oversized batches span pages with `{batch,part,complete}` boundaries. `part` is
the one-based entry offset within the original batch, not a page number, so it
stays stable across byte-sized pages and compaction. Consumers persist multipart
staging before ack, publish only on completion and discard staging on reset.

Every packet has an opaque one-use token. Only an exact `{ack:token}` from its
current owner permits cursor CAS. A gap must be acknowledged before a fresh
snapshot starts. Snapshot pages are transient metadata, at most 128 entries and
1 MiB; only the final ack installs the inventory's watermark. The inventory and
watermark are captured synchronously, then writes during paging replay strictly
after that watermark. Retention is rechecked at each page and after snapshot
delivery. Incomplete inventories are never durable progress; restart, retention
loss or five minutes of observed expiry starts a new reset.

Replay always rereads SQLite, including on retry, rather than retaining live
publication names. Deleted entries can therefore be anonymous even when an
earlier created/modified entry is replayed. Named replay/snapshot candidates
recheck canonical containment, state/staging exclusion and descendant symlinks
through the existing driver-path checks, without receiving driver authority.
Queued transports call the follower's disclosure callback at actual dispatch,
so deletion during an ordinary service FIFO wait cannot reveal an earlier name.
Ordinary delivery errors retain the cursor and report `changes_delivery_failed`,
retrying after five seconds of observed time, doubling to five minutes. Owner
retirement fences late replies and releases timers/inventory/subscriptions.

This is at-least-once delivery of retained recorded facts, not historical byte
storage or exactly-once external effects. A current read can already be newer
than a logged hash. Hashes are versions, not historical retrieval handles.
Neither this feed nor its snapshots strengthen the legacy backup guarantee.

`server/plugins/changes.ts` binds each declared subscription to its current
service Worker, canonical whole-vault read authority and host-selected plugin id.
The runtime starts it only after combined readiness and stops it synchronously
on failure/retirement/setup/access transitions. Ordinary FIFO argument preparation
performs the final disclosure check; no eager packet is sent after a queue wait.
Read-only observation can update host delivery progress without authorizing
plugin content/private-data writes. Catalog/status expose declaration, API version,
cursor/lag/reset/last-error metadata; uninstall also sweeps cursors for plugins
removed while offline. See [plugin API](plugin-api.md#acknowledged-log-facts-changes-api-1).
Canonical grant roots are re-derived at planning, dispatch and acknowledgement.
Retargeting a grant symlink cannot disclose an already-queued packet or relabel
an old snapshot's ack with new authority. A changed key resets recovery; an
unavailable whole-vault grant releases the inventory and reports delivery failure.

The search index removes obsolete note text and names too, including FTS5
segments and SQLite free space. Its owner enables both FTS5 `secure-delete` and
SQLite `secure_delete`, then checks a TRUNCATE WAL checkpoint after each erasing
transaction. A committed hub batch shares one checkpoint, including ordinary,
driver and rename-away changes. Checkpoint failure is reported rather than
treated as completed erasure. Other tools' copies and versioning retention remain
independent.

The index is derived data and uses WAL `synchronous=NORMAL`; the hub's durability
policy is separate. A crash or power loss may lose recent index transactions.
Restart reconciles the index from the live folder, reapplying and physically
erasing a deletion if its index transaction was lost. A current-format reopen
also retries the erasure checkpoint at its first outer transaction, even when
the committed deletion survived and there is no remaining row to reconcile.
Completed erasure and rebuild publication still require the checked checkpoint.
Search queries continue
to use the index while the existing initial-sync process catches up.

Index format 11 performs a one-time fresh-file rebuild of older indexes to purge
legacy deleted data. It publishes the complete new database by atomic rename;
an incomplete rebuild leaves the old canonical index available for retry. Fresh
installs create format 11 directly. No note files are moved by this upgrade.

## Current parsed metadata

`server/metadata/projection.ts` is one memory-only owner per vault, composed by
`main.ts` and injected into service RPC/runtime owners. It follows the same
`LogFollower` gap/snapshot/replay contract with an in-memory cursor, not a plugin
cursor row. Restart or retention loss rebuilds from current files. It persists
no parsed values, names or content in a new database.

Its hub subscription synchronously removes changed, deleted and old rename keys
from the current and staged maps. Later follower turns read bounded current bytes,
verify the planned raw-byte hash, decode strict UTF-8 and run the pure Markdown
parser. Every asynchronous result rechecks current seq and safe canonical target;
retirement fences it before hub close. A changed byte version re-plans, confirmed
absence reconciles through the scanner, and unknown I/O/parser/size failures are
explicit per-note unavailable records rather than stale values or empty success.
Snapshot pages and multipart groups stage ready results and publish together.
Queries report catch-up state and revision-invalidated paging.

`parse.ts` uses the existing markdown-it token rules and shared frontmatter subset,
without loading the renderer, Prism or plugins. `query.ts` owns bounded structured
filters/windows; `service.ts` owns exact current read-grant projection and managed
Worker watches. Ordinary FIFO dispatch rebuilds a watch result immediately before
disclosure. RPC replies use the same synchronous disclosure boundary. These APIs
do not require whole-vault log access. See [metadata API](plugin-api.md#current-note-metadata)
for record types, unavailable/count semantics, parser boundaries and limits.

The owner caches the sorted read catalogue and safety by path key/sequence.
Namespace publications clear directory-name indexes and safety observations, and
release parsed catalogue references synchronously. `DriverPathIndex` shares the
existing containment policy while observing each directory's NFC names once per
projection namespace; it never caches route kind, symlinks or canonical state.
Get is a direct current-key lookup. Prefix windows use binary search, grant roots
resolve once per query, and only the bounded candidate window rechecks actual
routes and exact grants. Global filters/counts remain in-memory scans, not
filesystem scans. Default driver callers retain fresh, uncached `driverTarget`.

## Sync peer metadata (M5)

Each configured driver instance is a separate peer and vector dimension, even
when several instances use the same plugin. New instances are off. Their ids
are permanent slugs, never reused after removal; `local` and `globnotes` remain
reserved. Removal retires the peer and clears its settings and delivery metadata,
without changing vault files. Configuration updates use the instance revision.

Schema v4 adds plugin/settings/enabled/revision to `peers`, progress in
`peer_sync` (endpoint id, epoch, scope, cursor, export sequence), and
`peer_files` (per-peer keyed path hash, hub version, native revision, delivery
state, attempts, next retry). No file names or bodies live in those tables.
Native revision tokens must not embed paths. A new endpoint id or epoch resets
only that peer's mappings and cursors; scope changes detach exclusions and forbid
omission-based deletion for that pass.

`changes.batch` is the first sequence of a metadata transaction. Migrated rows
without a batch stand alone. `HubStore.apply` runs the importing peer's
acknowledgement inside the same SQLite transaction as its file changes, before
subscribers run. An acknowledgement error rolls back both metadata changes.
`VaultHub.record` and `HubGate.apply` accept the bound peer and acknowledgement;
existing writers retain `globnotes` by default.

`NoteOperations.applyDriverImport` owns driver application: the normal note lock,
lifecycle admission and commit gate, one synchronous hub gate pass per ready
group, attachments before notes and deletions last. The host supplies the peer;
driver messages do not choose it. Members carry the hub version observed while
planning; a change during a wait requires re-planning that member. Pre-guards do
not run for remote input: post-facts use `origin: external` and `metadata.peer`.
Actual effects reconcile cache/index and reach the normal asynchronous
best-effort versioning path. All incoming bytes and native historical base text
live only for the call.

Equal bytes are adopted without a write. A metadata-only native revision change
also adopts without a copy when its bytes still match the acknowledged endpoint
version, preserving any newer local edit and its owed export against the fresh
revision. Held observations are not accepted bases: a locally recreated held path
still preserves the remote alternative. A changed remote revision replaces a
still-matching mapped hub version. Divergence with a verifiable historical text
base can merge; otherwise the incoming bytes become a sibling conflict copy
named with the instance id (`stale-base`, or `unknown-base` on first collision).
Mapping acknowledgements describe what the endpoint holds, not merged bytes or
the original file. The exporter compares current hub versions with mappings:
equal means no export, regardless of authorship. It never fabricates a driver
edit when that endpoint adopts a hub version.

A deleted-here file that returns with different remote bytes is held rather
than recreated; explicit Restore can create it. An unchanged mapped remote
version instead leaves a remote deletion obligation. Deleted names remain
transient: after restart, a nameless mapping is `delete-pending` until discovery
supplies its name. Snapshot omission proves absence only for a complete,
comparable pass with no unknown/locked observations; an unexpectedly empty
remote infers no deletions and requires a decision. A remote deletion concurrent
with a hub modification keeps the modification and drops its old mapping so it
can be recreated there. Excluded, unsupported and held paths are not exported;
uncertain effects require observation before another send. Oversized files are
unsupported, never truncated or deleted to make them fit.

Groups share one recorded batch and publication to cooperative hub consumers,
not filesystem-wide atomic visibility to outside programs. A crash during file
effects can precede recording; the scanner later observes the actual files as
local and a subsequent import adopts equal bytes. No rollback overwrites newer
outside work, and no hub journal retains content for crash replay.

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

## Conflict metadata and reads (M3)

Each vault owns its conflict records, record `revision` and monotonic metadata
revision. Schema v3 adds revisions in place; existing records start at 1.
Creation, conditional closure and member renames increment revisions in the same
SQLite transaction. No content, base, patch, merge draft or resolution history
is stored. Keep both closes metadata without changing names or file sequence;
later deletion still scrubs both member paths of resolved records.

The scanner and managed effects reconcile relationships through `HubStore.apply`.
An unambiguous rename updates member names and keyed hashes from pre-batch
identities (including swaps/chains). Ambiguous moves stay delete/create. Deleting
either member closes and scrubs the relationship; editing it or making both
files equal does not. Startup, watcher hints and periodic scans repair outside
changes. Unknown/unreadable is never absence. Multiple copies may share an
original; relationships close only on actual member deletion or explicit choice.

| # | Authenticated read | Response |
|---|---|---|
| 1 | `GET /_/api/conflicts` | `{revision,total,conflicts}`; open rows oldest first, metadata only. Count equals the visible rows |
| 2 | `GET /_/api/conflicts/:id` | Open: `{id,revision,state:'open',original,copy}`. Each member has `path,version,size,mediaType,preview` and complete `content` only for valid UTF-8 Markdown up to 16 MiB |
| 3 | Same id after closure | `{id,revision,state:'resolved',resolvedAt}` only; no historical names or content. Unknown/hidden open ids return 404 |

Reads are `Cache-Control: no-store`, scoped to the request's vault hub, and
project both members through the ordinary browser readable namespace. Hidden,
reserved, state and descendant-symlink members cannot contribute rows/counts.
Versions hash the exact raw bytes read with the body, including a BOM and line
endings. Binary, oversized and invalid UTF-8 bodies are not truncated or decoded
lossily for merging. Confirmed missing members are reconciled before returning
closure; other I/O errors propagate. The write gate and its filesystem CAS and
best-effort versioning limits are unchanged.

## Explicit conflict resolution

`POST /_/api/conflicts/:id/resolve` accepts `{action,revision,base,content?}`.
`action` is `original`, `copy`, `both` or `merge`; only merge accepts content.
`base` contains both `original` and `copy`, each `{kind:"version",version}` for
the exact raw bytes displayed by detail. Member paths come from this vault's
record, never from the caller. Missing either base returns `428 base_required`;
malformed input returns 400 before hooks or effects. Whole-vault read-only mode
refuses every action, including metadata-only Keep both.

| # | Action | Effects |
|---|---|---|
| 1 | Original | Leave Original byte-exact; remove only the selected Copy |
| 2 | Copy | Replace Original with Copy's exact bytes; verify, then remove Copy |
| 3 | Both | Close this relationship only; both filenames and bytes remain |
| 4 | Merge | Write the exact submitted UTF-8 string at Original; verify, then remove Copy. Complete Markdown text is required on both sides |

Resolution is one `NoteOperations` lock/admission/guard/commit workflow, not a
sequence of public save/delete calls. All applicable pre-save/pre-file-write and
pre-delete guards run before the first effect with one operation id/deadline.
The original HTTP mutation lease, epoch, guard authority, readable canonical
regular-file targets, record revision and both byte versions are revalidated
inside the lifecycle gate. Stale review returns 409
`{code:'conflict_stale',status:'stale',id}` without resolution effects. A renamed
record is stale even if its bytes are unchanged. There is no automatic merge,
H1 rename, attachment move, link rewrite or additional conflict copy.

One `HubGate.apply` journals actual file effects with origin `api`. Replacement
must be verified before Copy removal. Deletion performs the ordinary metadata
closure/scrub; Keep both uses conditional closure without a file sequence.
Completed Markdown effects reach cache/index, ordinary lifecycle facts and one
managed sync; displaced bytes use the unchanged asynchronous versioning path.
The short external check/effect race remains: this is not filesystem CAS.

Success returns `{status:'settled',id,revision,action,remaining,removed}` with
transient path/version receipts. A well-formed request for a known closed record
returns `{status:'settled',id,revision,alreadyResolved:true}` without historical
names or effects. Partial I/O or reconciliation failure reports
`operation_partial` with actual completed paths and the failed path when known;
it never claims stale/no effects after displacement. Failed replacement retains
Copy. No rollback overwrites newer outside work. Review actual state before any
new choice; lost replies do not authorize blind replay.

## Browser changes

`GET /_/api/changes` with `Accept: text/event-stream` emits `change` frames
with a sequence `id` and `{seq,path,kind,oldPath?,hash?,peer}`. Resume through
`Last-Event-ID` or `?since=N`. Comment heartbeats run every 25 seconds (`CHANGE_STREAM_HEARTBEAT_MS` in
`shared/vault_changes.ts`).
`?since=N&poll=1` returns `{entries,next,conflictRevision,driverRevision}` or
`{gap:true,next,conflictRevision,driverRevision}`, including metadata-only empty packets. Cursors older
than retained history, cursors beyond the current log, and replay containing
anonymous deleted names require a snapshot reset. Live deletion frames retain
their transient path. Neither transport discloses anonymous keys or origins.

Read authorization is the same as note reads, rechecked before stream emissions
and heartbeats; expiry and policy changes close streams. Each connection owns
one file, one conflict and one driver-state subscription on the same connection, all
disposed on disconnect. Hidden paths, reserved app paths,
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

Row 5 is shared with plugin-host events through `client/connectionLifetime.js`:
one visibility grace and document-lifecycle owner for all long-lived connections,
on every origin. Plugin contributions unload at suspension; resume refetches the
catalog, reactivates contributions and subscribes again. The stream's initial
`hello` refetches once more, covering changes between the read and subscription.
Vault changes retain their cursor across suspension.

`event: conflicts` carries only `{revision}`, with no SSE `id`, paths or count.
It uses the same authenticated emission queue and lifetime as file events and
sends the current metadata revision on every reconnect. `vaultChanges.js`
validates/deduplicates metadata separately from file sequence, fencing retired
connections. Consecutive successful polls share the owner's revision memory:
an equal revision is quiet, while any different revision (including a lower one)
invalidates consumers. A real transport reconnect, stream retry, owner restart
or page-lifetime resume delivers a fresh snapshot even at the same revision.
Rows/counts come from the filtered list, never from this invalidation cursor.
`event: drivers` likewise carries only `{revision}`, without an SSE id, settings,
keys or paths. Its own revision memory shares the same reconnect/poll lifetime
without advancing or suppressing either other domain. Settings -> Sync reads the
instance API after this fact; local drafts and key-input ownership survive reads.
Failed list/comparison reads retry independently with bounded backoff, paused
while the page lifetime is inactive and retired with their account/selection.
Definitive authority/identity rejections retain explicit recovery. Read retries
never resend resolutions or accept a stale pair on the person's behalf.

This keeps open streams to visible tabs: on plain HTTP each stream holds one of
the browser's few HTTP/1.1 connections per host, shared by all tabs.
`client/api.js` owns fetch streaming and the JSON polling fallback.

## Driver keys and Settings

The supervisor owns per-instance scheduling, configuration CAS and write-only key
delivery. `driver-secrets.sqlite` is a separate mode-0600 file in the configured
state directory, with secure delete and DELETE journaling. It is never part of
`hub.sqlite`, plugin settings/data or browser storage. Worker generations can read
only their own declared keys; setting/clearing a key retires that generation.
Removal retires the peer and deletes its key rows, not files on either side.

When state is inside the vault, Settings -> Sync names its path and explains that
outside whole-folder copies include keys. Keep state outside such copies with
`GLOBNOTES_INDEX_PATH`. Ordinary local-domain HTTP supports key entry; off a trusted
LAN a TLS reverse proxy such as Caddy or Nginx Proxy Manager protects that link.
See [drivers.md](drivers.md) for the lifecycle, storage SDK and native-history
limits, and [plugins.md](plugins.md#sync-plugins-and-instances) for the UI workflow.
