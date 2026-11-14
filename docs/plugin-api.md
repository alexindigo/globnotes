# Plugin API

globnotes' plugin platform is a single generic model: one plugin can
contribute rendering/editor extensions, lifecycle hooks, commands,
declarative settings pages, and sandboxed HTTP endpoints through supported
host interfaces. Enablement, plugin configuration and plugin data belong to
the **vault** (following Obsidian's ownership model); theme/keybindings stay
browser preferences.

## The default: `on-*` hooks

For replayable facts from **all peers**, use the opt-in log feed below. `on-*`
remains the best-effort operation interface, with its existing payloads/order.

The normal integration point is an **after-the-fact hook**: the operation has
already succeeded, and your handler receives immutable snapshots.

```js
// main service entry (manifest runtime.server)
export function activate(ctx) {
  ctx.hooks.on("on-save", (fact) => {
    // fact: { operationId, action, origin, timestamp, path,
    //         before, after, contentChanged, ... }
  });
}
```

Facts are delivered ordered per plugin under normal operation. Delivery is
**not** lossless: queue overflow, unavailable workers, deadline failures and
crashes are recorded as visible delivery failures (plugin diagnostics +
degraded status), never silently dropped — but they never block or fail the
note action either.

## The exception: `pre-*` blocking guards

> **Can block actions.** A `pre-*` hook runs before any filesystem effect
> and can cancel the operation by returning `{ cancel: true, reason }`.
> Handler errors, timeouts and an unavailable required guard ALSO cancel
> (HTTP 503 `plugin_guard_failed`); explicit cancellation is HTTP 409
> `plugin_cancelled`. The Settings UI always shows which actions a plugin
> can block. Only declared, registered guards have this authority — an
> on-only plugin can never acquire it.

During a pre-hook, nested note/file mutations and deferred mutating action
requests are rejected; reads and the plugin's own private data writes are
allowed. A failed enabled guard stays an expected blocker until it recovers
or is explicitly disabled — a crash never silently removes protection.

Guard admission has a separate bounded lane: one active and one pending guard.
An active observer or full ordinary FIFO cannot block that lane. Ordinary work
retains FIFO order; guard overflow/deadlines and required-owner failures remain
explicit failures, and pending work is settled when its owner retires.

## Manifest

```json
{
  "id": "my-plugin",
  "runtime": { "server": "service.js", "client": "app.js" },
  "hooks": ["on-save", "pre-delete"],
  "settings": [ /* declarative page descriptors (declarative-v1) */ ],
  "capabilities": { "network": false, "imports": false, "read": ["vault"], "write": [] }
}
```

Every contribution is optional: `main.js` (legacy rendering), `client.js`
(editor factories), `runtime.server`, `runtime.client`, `settings`, and an
`endpoints/` directory are independent; one plugin may supply them all.
Declared server hooks require `runtime.server`. Service workers read their code
and host-shared modules directly; vault reads/writes use the mediated facade
against declared grants. Legacy render pools keep their documented direct
filesystem envelope.

### Sync driver contribution (driver API 1)

A manifest may additionally declare `driver: {entry, apiVersion: 1, settings,
secrets, capabilities}`. It can be the plugin's only contribution. `entry` is a
contained basename module, `settings` is one declarative-v1 field array, and
`secrets` declares at most eight `{key,label,description?,required?}` fields.
`required` is strictly boolean and defaults to true. Missing optional keys permit
Worker construction; selected-configuration requirements return typed locked from
`open`, before endpoint I/O (see [driver guide](drivers.md)). Secret keys
match `^[a-z][a-z0-9_]{0,31}$`; values never belong in settings. The catalog
exposes only these declarations and static capabilities, without running code.
Unknown driver/capability properties and unsupported API versions are rejected.

Every configured instance gets its own authoritative `driver` Worker, independent
of service and render Workers, with the plugin's effective network/import scopes.
It can read its code and shared host modules, never the vault or state directory,
and gets no raw write, environment, subprocess, FFI or system permission. The
driver contribution authorizes sync of every tracked vault file through the hub;
it does not use `capabilities.write` or receive an application file facade.

`activate(ctx)` must call `ctx.driver.serve({open,discover,read,apply,close})` once.
All five methods are required; functions remain inside the Worker. The driver
context has only `createUuid`, frozen `instance: {id,label,settings}`,
`secrets.get(key)`, `driver.serve`, `driver.hint`, `driver.storage`,
`driver.StorageError`, managed `timers` and `register`.
No hooks, commands, endpoints, permissions, plugin data, file, action or
versioning facade is available to this role. Host dispatch binds the instance;
no driver message can name another peer or secret namespace. Secret lookup
rechecks the owning generation after an awaited lookup, before disclosure.

The host calls `open` once per generation. Ready binds `{endpoint:{id,epoch},
scope}`; locked and failed are explicit outcomes. `discover({mode,cursor?})`
returns bounded pages for that exact binding. `read({path,revision})` returns
known bytes, absent, unknown or locked. `apply(items)` returns exactly one typed
receipt per item. A settled put requires a native revision; conflict, uncertain,
failed, excluded and unsupported are distinct outcomes. `close` returns no data.
Every control envelope and result is validated; malformed results retire only
that instance with `driver_contract_violation` before they can be applied.

Pages have at most 1000 entries and 1 MiB of metadata; reads have at most 16 MiB
of bytes and optional historical base text only when advertised. Exports have
at most the manifest's `maxBatch` (1-64) items and 16 MiB combined bodies. Paths
are relative, slash-separated and NFC-compared, at most 4096 UTF-8 bytes, with
no dot/empty/parent segments or staging names. Canonical state, links and disk
spelling collisions are checked again at the hub boundary. Native revisions
are opaque strings of at most 512 bytes and must not contain file names.

Open/discover/close have 30-second observed-time deadlines; read/apply have
120 seconds. A lost read result is unknown, never absence; a lost apply reply
is uncertain, never proof of failure. The existing heartbeat/readiness ownership
also applies to driver Workers, so a hung instance cannot block another one.
Driver console arguments are not forwarded; asynchronous exceptions report only
value-free failures. The instance's host must redact typed state reasons/errors
before publication. The host retains no read bodies or historical text.

The [driver author guide](drivers.md) documents every result, storage-provider
method, bound and recovery rule. Incomplete discovery pages and unknown reads
may carry strictly validated `error: {code,retryAfterMs?,message?}` so typed
provider failures survive the Worker boundary without changing absence/cursor
semantics. Rate limits preserve retry advice, authentication locks the instance,
and sandbox network denial remains distinct. The storage SDK refuses a provider
whose actual native-condition support is weaker than its static conditional
manifest promise. Emulated conditions require explicit disclosure; they are
fresh checks followed by writes, not native CAS.

### Instance controls and key custody

The per-vault supervisor starts after the hub inventory and plugin owner
composition. Instances run concurrently; each session serializes its own cycles
and attention decisions. Hub publications debounce exports for one second;
discovery runs every 60 seconds. Hints and Sync now request discovery. Retry uses
observed time, from five seconds doubling to five minutes, honoring longer native
retry advice. The public `nextRetry` is the remaining observed milliseconds, not
a wall-clock deadline. Off, starting, active, locked, failed and read-only paused
are separate states. Reads alone do not start an instance or advance its revision.

Driver owners participate in PluginManager's policy, permission reduction,
settings-source recovery and explicit code replacement paths. Disable, instance
reconfiguration, key changes, access-policy epochs and shutdown synchronously
retire old Worker/session authority before cleanup. A held native read cannot
apply through the replacement's authority. Permission recovery rechecks source,
owner epoch and effective scopes before publishing readiness; code changes need
the explicit source-replacement workflow. Drivers cannot publish permission
contributors or request grants themselves.
Same-code narrowed recovery and automatic retries retain their admitted scope
ceiling; they cannot borrow a service's expansion before its SDK receipt settles.

All controls use the ordinary authenticated settings authority, captured before
body acquisition and rechecked at the metadata effect. Bodies are bounded to
1 MiB and 30 seconds of observed time. Responses are `Cache-Control: no-store`.
Ids select only the request's vault; unknown or retired instances return 404.

| # | Route | Input / result |
|---|---|---|
| 1 | `GET /_/api/drivers` | `{revision,notice,plugins,instances}`; declarations, settings and state, never key values |
| 2 | `POST /_/api/drivers` | `{plugin,label,settings?}`; creates off, returns `{id,revision}` |
| 3 | `PUT /_/api/drivers/:id` | `{revision,label,settings,enabled}`; strict declarative values, revision CAS, restart only that instance |
| 4 | `DELETE /_/api/drivers/:id` | `{revision}`; retires the id permanently and deletes its keys, leaves all vault/remote files |
| 5 | `PUT /_/api/drivers/:id/secrets/:key` | `{revision,value}`; set/replace a declared key, returns only declarations/set/time plus the new revision |
| 6 | `DELETE /_/api/drivers/:id/secrets/:key` | `{revision}`; clear and restart; no key GET exists |
| 7 | `POST /_/api/drivers/:id/sync` | `{revision}`; request a full cycle without changing configuration |
| 8 | `POST /_/api/drivers/:id/decisions` | `{instanceRevision,attentionRevision,action,paths?}`; fresh revision-bound held restore/delete or remote-empty delete/upload |

Stale configuration/attention returns 409 `driver_stale`; read current state
before another explicit choice. Missing revision returns 428. Attention decisions
re-observe the endpoint and retain the request guard across native body waits and
the managed import gate. Partial completed effects use `operation_partial`, never
a false no-effect stale success. Attention tokens cannot alias after restart.

`driver-secrets.sqlite` lives beside existing server keys in the configured state
directory. Its owner creates a regular mode-0600 file, refuses insecure existing
files/symlinks without changing them, and uses SQLite secure delete with DELETE
journaling (no WAL). Keys are never part of hub metadata, plugin data/settings,
Worker initialization, catalogs, facts or diagnostics. Missing required keys lock
an instance before Worker construction. RPC serves only a declared key of the
bound current generation. Raw, URI-encoded and base64 key forms are redacted from
driver diagnostics and public state. Clearing/removal securely deletes the row;
shutdown fences and settles sessions before closing key storage or hub metadata.

Key entry uses the page's connection, including ordinary local-domain HTTP. Off a
trusted LAN, use a TLS reverse proxy such as Caddy or Nginx Proxy Manager to protect
the link. When state is inside the vault, `notice` names its canonical path:
outside tools copying the whole folder copy keys too. Keep state outside those
copies with `GLOBNOTES__METADATA_PATH` (vault state is `<metadata>/<name>/`).

## Acknowledged log facts (changes API 1)

Declare `"runtime":{"server":"service.js"},"changes":{"apiVersion":1}` and
register exactly one `ctx.changes.subscribe(handler)` during activation. Unknown
changes keys/versions, missing service entry, missing registration, duplicate
registration and undeclared subscription are rejected. Disposal retires the
required subscription's Worker. No declaration means no log feed.

The existing vault enablement and canonical file-read grants authorize delivery.
Raw log access requires a read grant covering the **whole vault**: anonymous
deletions cannot be safely classified under a narrow pathname grant. Narrow grants
are explicitly rejected (`changes_read_grant_required`), not silently expanded.
Network permission never grants file access. Canonical host state, staging files
and descendant symlinks stay excluded. This is not driver or secret authority.

```js
export async function activate(ctx) {
  ctx.changes.subscribe(async (packet) => {
    await persistAndDeduplicate(packet); // your private JSON CAS or own storage
    return { ack: packet.token }; // exact token, only after successful processing
  });
}
```

| # | Packet | Meaning |
|---|---|---|
| 1 | `{type:"gap",gap:true,reason,logId,next,resetId,token}` | Ack the reset barrier before snapshots. `next` is informational, never permission to skip recovery |
| 2 | `{type:"snapshot",resetId,watermark,entries,page,complete,token}` | Current-file metadata pages; each entry is `{path,pathKey,hash,size,mtimeMs,vector,seq}`. Only final ack installs watermark |
| 3 | `{type:"changes",logId,from,to,entries,batches,token}` | Ordered retained facts strictly after `from`, ack the entire scanned page through `to`, including filtered entries |

Entries contain `{seq,batch,path,pathKey,kind,oldPath,oldPathKey,beforeHash,
afterHash,peer,origin,at}`. Names include extensions. `kind` is created, modified,
renamed or deleted. `peer` is local, globnotes or the driver instance id; `origin`
is the recorded detail, such as api or plugin:<id>. Equal-byte adoption/export
acknowledgement creates no new authorship. No endpoint URL, settings or key crosses
the feed. Packets and nested values are frozen in the Worker.

Deletion scrubs names in SQLite, including earlier creates/modifications. Always
handle null `path`/`oldPath` and remove anonymous deletions by their vault-local
opaque HMAC `pathKey`. Never reconstruct names from another host cache. Both replay
and snapshot candidates are rechecked at actual Worker dispatch after FIFO waits.

One subscriber has one outstanding callback, at most 128 entries and 1 MiB encoded
control data, one pending wake-up and one transient metadata inventory. Fitting hub
batches stay together. Oversized batches use `{batch,part,complete}`: `part` is the
one-based entry offset within that batch. Persist staging before each ack, publish
the group only on completion, discard staging on reset. Restart can resume at a
tail only when your staged prefix was stored. Compaction never waits for a plugin.

Persist `(logId,seq)` deduplication and reset/page identities with your effects.
Delivery is at least once: a crash after your persistence but before host cursor
CAS repeats the facts. Undefined, partial, stale and forged acknowledgements do
not advance. External effects plus host cursor storage are not one transaction.
Failures show `changes_delivery_failed`, retain progress, and retry in observed
time after 5 seconds doubling to 5 minutes. The ordinary 30-second service-call
budget includes FIFO wait; guard and versioning lanes keep their own isolation.

The newest 100,000 log entries are retained independently of cursors. First
subscription, retention loss, replaced log, future cursor, changed read authority
or five-minute observed snapshot expiry produce explicit gaps. Gap/intermediate
page acks do not install progress. A snapshot inventories metadata and watermark
together, then replays writes after that watermark. It is not an atomic snapshot
of historical file bytes. A gap means your old projection is no longer caught up.

Read **current** bytes with `ctx.files.read(path)` -> `{body,mediaType,version}`.
Compare `version` with `afterHash`/snapshot `hash`: a mismatch is superseded,
NotFound is gone, other I/O errors are unknown. Null names have no byte read.
Track per-key applied seq/version so older replay cannot roll a newer snapshot
record backward. Hashes are versions, not historic-retrieval handles. Rapidly
overwritten versions, deleted bodies and unobserved local edits are unavailable
unless your plugin has its own history. The host stores no content spool.

See the test-only [log example](../tests/fixtures/plugins/globnotes-log-example/service.js)
for private JSON CAS, reset/page identities, multipart staging, deduplication and
version-checked reads. It maintains current keyed state, not an archive. No example
plugin is installed in production. The legacy backup remains on `ctx.versioning`;
log following does not strengthen its best-effort preservation guarantee.

The catalog publishes `changesApiVersion:1` separately from plugin contract 2,
the declaration and `changesStatus:{cursor,lag,reset,lastError}`. Runtime status
and bounded value-free diagnostics report failures. Disable, source/grant/access
replacement, setup, failure and shutdown fence dispatch and late acks, cancel
timers and release inventories. Disable retains the cursor; uninstall removes it,
including removal while the server was stopped. Re-enable resumes or resets as
required. Read-only mode permits observation and host progress, but does not grant
plugin data/content mutations; setup-pending starts no subscriber.

## Current note metadata

Service Workers have `ctx.metadata.get(path)`, `query(q)` and `watch(q,handler)`.
These need only the ordinary declared read grants, including narrow roots; no
`changes` declaration or whole-vault log grant is required. They observe the same
local-folder, editor/API, plugin and sync-driver facts. Driver Workers do not get
this facade. Read-only observation is permitted; setup and retired owners cannot
use it.

`get` accepts one strict vault-relative `.md` filename, including its extension,
and returns a current record or `null` for absence. Dot/parent/empty path segments,
backslashes, staging names and paths above 4096 UTF-8 bytes are rejected. Canonical
state and descendant symlinks are excluded. The host checks the exact read grant
and generation again at result disclosure, even for cached records.

```js
const note = await ctx.metadata.get("Work/Today.md");
const page = await ctx.metadata.query({
  prefix: "Work",
  property: { key: "status", equals: "active" },
  task: { checked: false },
  offset: 0,
  limit: 50,
});
const dispose = ctx.metadata.watch({ prefix: "Work" }, (page) => {
  // Replace your current view; restart pagination when revision changes.
});
```

Ready records are `{path,pathKey,version,seq,status:"ready",properties,headings,
links,tasks,fields}`. `version` hashes the raw current bytes; it is not a historical
lookup token. Properties preserve the shared frontmatter subset as ordered
`{key,value}` entries: scalar strings, string lists or raw text, without YAML type
coercion. Headings are `{level,text,line}`; links are `{target,label,embed,line}`;
tasks are `{text,checked,line}`; fields are `{key,value,line}`. Lines are 1-based.
Task text covers its first Markdown paragraph, including lazy continuations.
Repeated properties and inline fields retain order and occurrences. Link targets
are raw destinations (including reference links and wiki aliases/embeds), without
resolution, fetching or renderer URL rewriting. Treat them as data, not safe HTML.

The pure parser uses Markdown tokens and the shared frontmatter parser. Fenced,
indented and inline code and raw HTML do not create task/field/wiki facts. BOM and
CRLF preserve source coordinates; an unfinished opening frontmatter block produces
no body facts until it closes. No render plugin or HTML renderer runs.

Queries accept only `{prefix?,property?:{key,equals:string},task?:{checked:boolean},
offset?,limit?}`. Filters are ANDed; prefix is an NFC, segment-aware path without a
trailing slash. Property equality matches exact scalar strings or list members,
not raw values; task matches any task with that checked state. There is no SQL,
evaluation, regex, Dataview syntax or backlink resolution. Default limit is 50,
maximum 128; offsets are nonnegative safe integers. Results sort by NFC path.

Pages are `{revision,cursor,catchingUp,total,rows,unavailable,nextOffset?}`. Only
read-granted notes enter filtering, counts or pagination. `total` counts matching
ready records plus eligible unavailable candidates whose filters cannot yet be
determined. `rows` contains ready records and `unavailable` the explicit unknown
records in that same window; both consume the limit/offset. Never treat unknown
as a matching value or absence. `nextOffset` resumes the shared sorted window.
Any changed revision, including canonical grant drift, requires starting again
at offset 0. `catchingUp` means the projection has not reached the current log
cursor or is recovering/retrying; it does not promise historical completeness.

Unavailable records contain only `{path,pathKey,version,seq,status:"unavailable",
reason}`. Reasons are `reading`, `read_failed`, `too_large` (>16 MiB raw bytes),
`invalid_utf8`, `parse_failed` and `record_too_large`. Current values are invalidated
synchronously on a recorded change/delete, before asynchronous read/parse work.
Changed read versions re-plan; missing reads reconcile absence. Stale asynchronous
work cannot put back a deleted/renamed version. Ready results for one hub group
publish together, including groups spanning follower pages. Nothing parsed is
persisted to the hub or another host content database.

The projection owns a publication/sequence-qualified safety catalogue and cached
NFC directory-name indexes. Recorded changes synchronously release obsolete names,
parsed catalogue references and safety observations. Get uses one current-key
lookup; prefix queries binary-search the sorted catalogue. Counts/filters use that
observed namespace in memory, while only the requested window rechecks current
route kind, symlinks, canonical state and exact read grants at disclosure. A page
can be shorter when a selected route has become unsafe; its changed revision
invalidates prior pagination. Warm reads do not walk every vault directory again.

Get and query/watch results are bounded to 1 MiB encoded JSON. A single oversized
record becomes `record_too_large`; a page may return fewer records with
`nextOffset` when its combined byte bound is reached. Watch allows at most 16
registrations per plugin, returns a managed disposer, delivers an initial page,
then coalesces projection changes with one outstanding invocation per watch.
Queued results are rebuilt at actual FIFO dispatch under current grants; no
deleted parsed payload waits in the host queue. Handler failures report
`metadata_watch_failed` and retry after 5 seconds of observed time, doubling to
5 minutes. Disable, disposal, replacement, failure and shutdown fence old watches.
This is generation-scoped live observation, not a durable job or plugin store.

## Facades

| Surface | Contract |
|---|---|
| `ctx.createUuid()` | cryptographically random UUID-v4; available in browser and server contexts, including plain HTTP |
| `ctx.hooks.on(name, handler)` | declared `on-*`/`pre-*`; returns a disposer |
| `ctx.commands.register(def, handler)` | namespaced command; no overriding built-ins or other owners |
| `ctx.settings.read()/subscribe(fn)` | effective validated values; committed-change notifications |
| `ctx.data.load()/save(values, revision)` | private JSON with revision CAS; never in the settings catalog |
| `ctx.actions.request(action, args)` | acceptance-only `{ requestId }`; outcome via `ctx.actions.result(id)` / `onResult`; every write states its `base` ([Writes state their base](#writes-state-their-base)) |
| `ctx.files.read(path)` / `ctx.files.requestWrite(path, bytes, {base, onStale?})` | grant-checked mediated file access with the file's `version`; guarded `file-write` action |
| Server `ctx.versioning.onOffer(handler)` | captured displaced bytes delivered after commit ([Versioning](#versioning)) |
| Server `ctx.changes.subscribe(handler)` | opt-in acknowledged all-peer metadata feed (changes API 1, above) |
| Server `ctx.metadata.get(path)` / `query(q)` / `watch(q,handler)` | current parsed notes, bounded read-granted pages and managed live queries (above) |
| Server `ctx.permissions.declare({network,imports}, options?)` | complete host-bound contributor/source request snapshot; cannot grant access |
| Server `ctx.permissions.requestAccess({kind,hosts,reason}, options?)` | prompt admission `{requestId,revision,status,blockedReasons}`; does not wait for a human or grant traffic |
| Server `ctx.permissions.status()` | owning current request/approval/effective projection and source token |
| `ctx.register(disposer)` / `ctx.timers` | generation-scoped cleanup, even when disposal throws |
| Browser: `ctx.events.on` / `ctx.actions.dispatch` | managed bus facts/actions; dispatch returns the boolean from `dispatchAction` (`false` when refused, e.g. while a dialog is open); `true` is admission, not completion — observe facts for outcomes |

`createUuid` is also exported by the browser's `@globnotes/plugin-sdk` module.
Use this helper for plugin identities rather than the secure-context-only browser
`crypto.randomUUID()`. It uses `crypto.getRandomValues()` and does not require
HTTPS or a publicly registered domain. An identifier does not confer permissions
or replace an authorization check.

### Settings persistence and definition changes

Every plugin with valid declared pages has one **Open settings** action in its
**Settings → Plugins** row and a navigation entry under **Plugin settings**.
Its declared pages appear as tabs in descriptor order. Server permissions live in
the expanded Plugins row; **Manage in Plugins** returns there from a plugin page.
Disabled plugins and failed runtimes with valid declarations retain their page
launchers; opening them does not enable the plugin or grant authority. Plugins
without declared pages have no invented settings launcher. Plugins with server code
expose permission controls through their disclosure. Catalog refresh updates current
declarations while host-owned captured drafts remain reachable for explicit
recovery. Renderer support stays `declarative-v1`; unsupported declarations are
rejected when the plugin definition loads.

Declarative page groups may set optional `"tone": "warning"` for risk notes about
a plugin's behaviour. This is the only supported tone value; omit `tone` for a
normal group. A warning group renders as a warning-tinted banner: its `label` is
the heading, its `description` is the warning text, and its declared `fields`
render inside the banner. Group descriptions are plain text (never HTML);
blank-line-separated paragraphs (`\n\n`) render as separate paragraphs in both
normal and warning groups. For example:

```json
{
  "id": "safety",
  "label": "Before you turn this on",
  "tone": "warning",
  "description": "Changes made elsewhere may be overwritten.\n\nMistakes are saved too.",
  "fields": ["enabled"]
}
```

Settings reads expose the current declared fields/pages with validated values and
declared defaults. Removing a field/page from an updated descriptor preserves its
raw saved data but omits it from current reads. Saving current fields retains that
removed data; compatible reintroduction reads its original value. Retained data
counts toward the existing 1 MiB storage bound. Invalid current values, malformed
or unsupported state and undeclared incoming fields still fail visibly; no
coercion or implicit storage cleanup is performed.

Hosted reads/writes capture their definition before storage waits and recheck it
against the owning source. A schema-binding mismatch reports
`plugin_settings_schema_conflict`; an earlier source-identity check can instead
report `permission_source_conflict`. Both reject the stale write before its effect:
a held request cannot validate under D1 and persist controls under D2. Definition
checks precede the final settings/requester authority assertion without an
intervening await.

The Settings UI retains an original definition while its drafts, invalid inputs,
requests or uncertain writes need recovery. A clean acknowledgement adopts the
latest available definition and reads its authoritative values before another
commit; an old-schema acknowledgement is not new-schema loaded data. Read-back
does not automatically replay a write or discard newer raw drafts.
An ordinary refresh of an already-loaded definition keeps explicit Save admission
from its known CAS; that commit fences the older GET. Initial/new-schema loads
remain unavailable for commits until their authoritative values arrive.

Browser command/event/timer registrations belong to their exact activation.
Managed registration checks lifetime before creating an effect and rolls back a
rejected adoption once. Retired activations cannot remove replacement commands or
receive new managed deliveries. These checks do not cancel arbitrary trusted
browser promises or sandbox same-origin code.

Browser `ctx.events.on("note:edit-state", handler)` receives current retained
state on a microtask after subscription, through the same managed,
failure-isolated handler used for live facts. Unsubscribe, rejected ownership or
generation retirement fences the queued delivery; a newer live publication
supersedes it. The payload is `{ path, revision, editing, unsaved, canSave }`,
never note text. Initialize and end session-dependent work from `editing`,
including the replay at activation; `note:edit-start` / `note:edit-end` are
non-replayed events. Exit/disposal publishes an inactive state. See
[event-bus.md](event-bus.md) for the retained-topic contract.

## Writes state their base

Every write says what it was based on, through one `base` argument, for every
action and payload (renames included):

| # | Base | Meaning |
|---|---|---|
| 1 | `{kind:"absent"}` | The path must not exist (a create) |
| 2 | `{kind:"version", version}` | The file's `version` as you read it: SHA-256 hex of its bytes, returned by `ctx.readNote`, `ctx.files.read` and action receipts (`ctx.fs.readFile` returns bytes only, and `ctx.fs` tokens are not versions; hash those bytes with SHA-256 if you read through `ctx.fs`) |
| 3 | `{kind:"text", content}` | A note's text as you read it; lets a stale save merge |

Each write is based on what you read for it:

```js
const note = await ctx.readNote("Tasks");
await ctx.actions.request("save", {
  path: "Tasks",
  newContent: note.content + "\n- [ ] new",
  base: { kind: "version", version: note.version }, // or {kind:"text", content: note.content}
  onStale: "refuse", // optional; default "copy"
});

const old = await ctx.readNote("Old");
await ctx.actions.request("delete", { path: "Old", base: { kind: "version", version: old.version } });

await ctx.files.requestWrite("img/chart.png", bytes, { base: { kind: "absent" } });
```

`request()` only admits a write, and admitted writes can complete in any order.
A write that depends on an earlier one takes its base from that one's receipt,
for example a rename after a save:

```js
const saving = await ctx.actions.request("save", { path: "Tasks", newContent, base });
ctx.actions.onResult(async (receipt) => {
  if (receipt.requestId !== saving.requestId || receipt.status !== "completed") return;
  const saved = receipt.result; // the note as written, with its new version
  await ctx.actions.request("rename", {
    path: saved.path,
    newPath: "Done/Tasks",
    base: { kind: "version", version: saved.version },
  });
});
```

| # | Action | Without `base` | Stale `base` |
|---|---|---|---|
| 1 | `create` | Implicit `absent`; only `absent` is accepted | Exists: refused (`note_exists`) |
| 2 | `save` (content) | `base_required` | Text base merges when it can; otherwise `onStale`: `copy` keeps your text as `<name>.conflict-YYYYMMDD-HHMMSS-globnotes.md` next to the original (recorded as a conflict), `refuse` fails with `base_stale` |
| 3 | `rename` (with or without content) | `base_required` | Refused (`base_stale`); with content, as row 2 |
| 4 | `delete` | `base_required` | Refused (`base_stale`); nothing is deleted |
| 5 | `file-write` / `requestWrite` | `base_required` | Notes as row 2 (an `absent` base on an existing note keeps both under `copy`). Other files are binary: never merged; `copy` writes `<stem>.conflict-...-globnotes.<ext>`, `refuse` fails. Outside the vault: always refused |

Receipts of note writes carry the note with its `version` and `saveResult:
{status: saved|merged|conflict, conflictCopyPath?, recreated?}`; a file write's
result is `{path, version, saveResult}`. `base_stale` carries no content. A
`base_required` refusal also adds a `plugin_contract_2` diagnostic to the
plugin, so a contract-1 plugin is visible in Settings. `ctx.fs` keeps its own
token conditions (`expect`, `sourceToken`, `token`), which are its bases.

## Contract version

The contract version is published as `contractVersion` in the plugin catalog,
the server Worker's init `ctx.snapshot`, the browser SDK snapshot and the
plugin-host events `hello` frame. It is **2**:

| # | Change from 1 | Compatible |
|---|---|---|
| 1 | `save`, `rename`, `delete`, `file-write` and `requestWrite` require `base` (above) | No: refused with `base_required` |
| 2 | Render Workers get no file write permission; `capabilities.write` only grants action targets (a render-only plugin declaring it gets a `plugin_write_grants_unused` diagnostic) | No: `Deno.writeFile` fails with `NotCapable` |
| 3 | Reads and receipts return `version`; receipts return `saveResult` | Yes |
| 4 | `ctx.fs` effects in the vault are recorded as the plugin's and offered to versioners; staging files are `.globnotes-staging-<uuid>` | Yes |
| 5 | Manifest `versioning` and `ctx.versioning.onOffer` | Yes (new) |

Plugins that only read, render, hook, keep settings or data, serve endpoints
or use `ctx.fs` keep working. To migrate a writer: read the note or file first
(`version` or the text), pass it as `base`, choose `onStale` for content that
cannot merge, and handle `saveResult` and `base_stale` in your receipts.

## Deferred actions and invocation lifetime

A saved server `ctx` belongs to its owning vault and Worker generation. It remains
usable after `activate()` returns: startup network continuations and managed
timeouts/intervals can use it without a note/file event or a logged-in browser.
Manifest grants, current writable policy and generation authority still apply.

Host-dispatched commands, endpoints and hook/result callbacks each have their own
internal invocation context. Awaiting a delay or RPC preserves that invocation;
resolving its promise from a managed timer does not turn its continuation into
background work. Managed timer callbacks are separate generation-background
executions, including timers registered by a handler. An unrelated slow observer
or pre-hook cannot lend its protection flag or causal parent to background work.
Detached native timers/continuations from a completed invocation cannot issue new
RPCs by borrowing a later job or silently becoming background work.

`ctx.actions.request()` and `ctx.files.requestWrite()` return an acceptance ID
promptly. Requests originating in a dispatched handler wait for that handler's
actual returned promise to settle before filesystem preparation/guards/effects
begin. Normal return and ordinary handler error release already accepted work;
the handler error does not undo its acceptance. Timeout, Worker crash, disable,
replacement or failed activation abort unstarted work. Startup requests also
wait for successful readiness. Already committed effects are accounted for
truthfully rather than rolled back, relabelled as unwritten, or replayed.

Do not await your own deferred action's completion before returning from the
originating handler: its execution is deliberately waiting for that return. Use
the acceptance ID with `actions.result()` or the managed completion subscriptions.
Completed receipts belong to the exact `(plugin, generation, request)` owner;
replacement instances cannot query or receive old-owner completions. A successful
receipt's `operationId` identifies the actual host fact and is distinct from its
`requestId`. Queries, subscriptions and independent hook observers disclose
content/effect metadata under their own declared read grants, not the sender's.
Settled receipts are released when their generation retires; unfinished receipts
remain accounted for until settlement and cannot be inherited by a replacement.

Every note/file mutation needs the declared write grants for its actual effects:
source and canonical destination, H1-derived renames, selected attachment moves
and required new directories. Optional directory pruning stops at the grant
boundary. Plugin-initiated directory-reference moves are rejected before effects;
general directory/file CRUD remains future work. The host rechecks requester
generation, writable policy, canonical containment and grants at the commit gate
after lock/guard waits. Private `ctx.data` is a separate owned/CAS namespace and
does not confer general note/file write rights.

Mediated service and render reads project all candidates through the owner's read
grants and exclude canonical host state. Exact path, basename and alias resolution
consider only eligible associations; no eligible match returns the ordinary
unresolved input echo. Explicit legacy raw filesystem permissions remain separate.

Context IDs and built-in async-local correlation are not cryptographic call-stack
attestation inside a shared JavaScript Worker. The host's manifest, vault/policy,
generation and guarded-commit checks remain the authority boundary. This v2
contract adds no public background-task/run facility; that and broader file APIs
remain v3 work.

## Effective settings and auxiliary filesystem

`GLOBNOTES_GLOBNOTES_PLUGINS_SETTINGS` is a bounded host-only JSON overlay addressed by plugin
ID → page ID → field key, parsed once per host lifetime. Environment fields win
leaf-wise over stored fields/defaults; explicit empty strings remain present.
Invalid/unknown addressed values fail visibly without logging values or repairing
private storage. HTTP/SDK reads and PUT acknowledgements expose effective `values`,
persisted numeric `revision`, opaque `sourceKey` and host-owned `fields` provenance
(`source: environment|vault|default`, `readonly`). Unchanged pins may be echoed by
complete-page saves; their exact stored fallback/absence is preserved. Pin changes
reject. New clients submit accepted sourceKey; legacy revision-only callers retain
their old behavior without new cross-restart source-CAS guarantees. Override
presence/fingerprints retire obsolete requests per plugin, preserving approvals.

Server services can separately declare mediated
`capabilities.filesystem: {read:[...],write:[...]}` roots: literal paths, `"vault"`,
or `{settings:{page:"page-id",key:"folder-field"}}` referencing the owning plugin's
declared folder/effective value. Empty adds no grant, never cwd; roots do not grant
`/`, siblings or ungranted missing ancestors. Raw Worker write/env/run stays denied.

The server-only completion facade is distinct from deferred action acceptance:

```ts
type FsToken = string;
type FsExpect = {kind:"absent"} | {kind:"exact";token:FsToken};
type FsOptions = {sourceKey?:string};
type FsStat = {kind:"file"|"directory";size:number;token:FsToken};
stat(path:string, options?:FsOptions): Promise<FsStat|null>;
realPath(path:string, options?:FsOptions & {expect?:{kind:"exact";token:FsToken}}): Promise<string>;
readFile(path:string, options?:FsOptions & {expect?:{kind:"exact";token:FsToken}}): Promise<Uint8Array>;
writeFile(path:string, bytes:Uint8Array, options:FsOptions & {expect:FsExpect}): Promise<{token:FsToken}>;
rename(from:string, to:string, options:FsOptions & {sourceToken:FsToken;destination:FsExpect}): Promise<{token:FsToken}>;
remove(path:string, options:FsOptions & {token:FsToken}): Promise<void>;
mkdir(path:string, options?:FsOptions & {recursive?:boolean;expect?:FsExpect}): Promise<FsStat>;
```

All relative arguments are vault-relative, not relative to a settings-root grant.
`realPath` returns an authorized **existing** canonical absolute pathname, with
no missing-path fallback. `stat` returns null only for authorized absence. Missing
reads/realPath give `fs_not_found`; missing conditional removal conflicts. Writes
prepare/sync a temporary file before atomic target publication. Rename/remove
are conditional file-only operations; mkdir defaults nonrecursive, authorizes
every needed component, and permits an existing safe directory.

Tokens are opaque owner/path/root/link/type/identity/content observations, not
authority or an unbounded host registry. Omitted sourceKey binds activation; a
fresh settings key cannot lend old executing code replacement grants. Source,
invocation/generation, namespace, grants and deadline are rechecked after waits
and before effect/disclosure. Canonical host state, pre-hook mutations and canonical
in-vault `.md` mutations are denied. Guarded note work still uses actions. Auxiliary
IO dispatches no note hooks/index updates and may be awaited from post-hooks.

Bodies are bounded at16MiB, paths at4096UTF-8 bytes, outstanding calls at64 per
generation and preparation at10seconds. The SDK captures selected bytes before
transport (including shared-buffer views); the host validates/copies independently.
Typed errors are `fs_too_large`, `fs_invalid_path`, `fs_busy`, `fs_denied`,
`fs_conflict`, `fs_not_found`, `fs_source_changed`, `fs_generation_revoked`,
`fs_deadline`, `fs_io_error`; rejected SDK Errors retain `effect: none|committed|unknown`.
Expiration cannot start later publication. A deadline is not rollback; lost replies
or post-effect errors do not prove no write. Tokens are not external filesystem
CAS, recursive CRUD or multi-file atomicity. Recovery inspects recorded states.

The shipped [backup plugin](../plugins/globnotes-backup/README.md) takes its
versions through `ctx.versioning` ([Versioning](#versioning)) and owns its
retention/journal policy. Adjacent files remain publicly readable
under ordinary serving policy.

## Versioning

This asynchronous, best-effort hook is kept for the **legacy v2 backup plugin**.
V3 versioning plugins can follow the acknowledged log feed above. It does not
add a save participant or change the rest of plugin contract 2.

The legacy service declares it and registers one handler:

```json
{ "runtime": { "server": "service.js" }, "versioning": { "extensions": [".md"] } }
```

```js
export function activate(ctx) {
  ctx.versioning.onOffer(async (offer) => {
    // offer: { operationId, kind: "replace"|"delete"|"move", path, newPath?,
    //          version, size, bytes: Uint8Array|null, origin }
    await keep(offer); // runs after commit; the save never waits
    // or: return { status: "declined" };
  });
}
```

After a write commits, the host enqueues the displaced bytes captured before
replacement, deletion or move (`extensions` omitted = every file; only paths
your read grants cover). Refused writes deliver nothing. Completed effects of
a partial write still deliver their displaced bytes. Reading the live path in
the handler sees the committed state, not the old version; use `offer.bytes`.

Each plugin has its own in-memory FIFO: one active handler, at most 8 pending
entries and 32 MiB of pending bytes, plus at most 16 MiB in flight. Overflow
drops the oldest pending entry and records a `versioning_gap` diagnostic with
its operation ID; the plugin is visibly degraded. Delivery while the plugin is
unavailable also records a gap. Failures and ordinary service-call deadlines
(30 s observed time, including queue wait) affect only that plugin's queue and
status, never the committed write. No versioning result appears in the save's
fact metadata. There is no separate versioning wait or deadline.

The handler runs in its own lane, not as a pre-hook: it may use `ctx.fs`, and
deferred actions it requests run after it returns. Writes made by any versioning
plugin are never offered to any versioner, preventing recursive backups.
`bytes` is null above 16 MiB, with a `versioning_failed` diagnostic.

The host writes no delivery spool, journal of note bytes or other content copy.
**If the server crashes before the plugin stores a version, that version is not
backed up.** Pending delivery is volatile and is not replayed on restart. This
best-effort limit matches v2 behavior; a successful save does not confirm a
successful backup.

## Endpoints

Plugin-local routes live at `/_/api/plugins/<id>/<route>` for
GET/POST/PUT/PATCH/DELETE (HEAD/OPTIONS/405 handled by the host from your
declared method table). `endpoints/` uses the filesystem grammar
(`get.js`, `item/#name/get.js`, `tree/#...route/post.js`); modules are
imported inside your worker, never by the host. Requests/responses are
bounded structured envelopes (16 MiB); credentials and cookies never cross
the boundary. Disabled plugins are 404 even while installed.

The host validates route grammar and equivalent method/path shapes before that
activation becomes ready. Admission captures the current route owner before
reading a body; unavailable routes acquire no reader, and a held request cannot
invoke a replacement generation. Local path captures are decoded once; repeated
query pairs remain separate.

Body acquisition allows exactly 16 MiB and rejects overflow before EOF. A separate
30-second whole-acquisition deadline returns 408; abort/stream failure also stops
dispatch. Cancellation is best-effort and never waits for a hostile cancel Promise.
Every normalized response branch obeys the encoded-byte bound, including plain
JSON; this does not bound allocations made before cloning/encoding. Method
advertisement includes the full matching union, synthetic HEAD only when GET
exists, and host OPTIONS for existing paths. HEAD/OPTIONS run no plugin handlers.

## Sandboxed server network consent

**These permission controls apply to sandboxed server Workers only.** Browser/editor
plugin code is trusted same-origin application code. These approvals and Allow
network do not restrict it, or browser network loads from rendered content.
Trusted browser code can exercise user app authority; explicitly privileged
legacy filesystem grants are a separate trust boundary. Consent endpoints are
not cryptographic attestation of a human gesture against that code.

`capabilities.network` and `capabilities.imports` independently declare requested
scope: false, true (all hosts), or an exact host/port list. Omitted imports retains
legacy network-derived **request intent**, never approval. New network-only
plugins use `imports:false`. Effective rights are the intersection of the
per-plugin Allow network master, requested scope, remembered operator approval
and already-granted parent authority. The default master is off. No permission
prompt or parent launcher widening is performed automatically.

Scopes are `{type:"host",authority:"canonical-host[:port]"}` or `{type:"all"}`.
Lowercase/IDNA and bracketed IPv6 are canonicalized. Port omission means **any port
on that host**. Credentials, URLs/paths and wildcard strings are rejected. Rights
do not implicitly extend to subdomains or redirected hosts. A requested all-host
scope may be approved narrowly; broad all-host consent is a distinct explicit
choice. Network approval never approves remote-code imports.

Requests and approvals are separate. Deleting an approval leaves a still-requested
row Unapproved; declaring again cannot restore it. Master off retains remembered
approvals. No-longer-requested approvals remain remembered but inactive. Parent
unavailability leaves approval remembered without effective authority. Coverage
by all-host/any-port grants is reported in `approvalCoverage`; an exact row cannot
be independently revoked while a covering broader grant remains.

Runtime declarations are complete snapshots for the host-bound service/render
contributor and source. They do not remove static intent or another contributor.
Identical render replicas deduplicate; divergent same-source snapshots fail with
`permission_runtime_conflict`. Explicit access requests deduplicate their pending
or terminal IDs. Declaration alone does not create a prompt. Cancel/dismiss defers
locally and stays Pending; explicit Deny is persisted; deletion marks matching
approved requests Revoked. Code/settings source retirement makes old requests
Obsolete without erasing approval.

The default publication token is the immutable activation source. After a settings
change, capture a fresh token **before** deriving hosts from settings:

```js
const view = await ctx.permissions.status();
const settings = await ctx.settings.read();
if (view.source.settingsRevision !== settings.revision) {
  throw new Error("Settings changed; read a fresh source before declaring");
}
await ctx.permissions.declare(
  { network: ["example.com:443"], imports: false },
  { source: view.source },
);
```

Late old-source publications fail 409 `permission_source_conflict`. Installed code
changes require explicit source replacement; old code cannot claim a new code
fingerprint. Permission-only replacement retains contributor snapshots, preventing
declare/reload loops. Local activation can complete pending consent; unapproved
fetch/import traffic remains denied. A static remote dependency may block module
activation, with requests visible from worker-free catalogue metadata.

A settings commit fences reduced raw rights synchronously at its storage effect;
it does not depend on a later browser/status read. After releasing the commit gate,
the host publishes retirement and admits identity-qualified, same-code narrowed
recovery of affected roles. Approvals/master and unrelated owners remain. If
settings persist but source publication/recovery admission fails, the response is
503 `plugin_settings_source_commit_failed`: read back before an explicit retry.
Persisted settings are not rolled back and old reduced authority stays retired.

Operator controls are protected host routes, not plugin SDK methods:

Expand a plugin in **Settings → Plugins** to inspect its server requests and
remembered approvals, including disabled and settings-less plugins with server code.
The expanded row replaces the old **Server permissions** pages and review dialog.
Legacy `core:plugin-permissions:<id>` opening requests select Plugins and expand
that owner after the existing departure guard. Network data and remote-code
imports have separate rows; All hosts approvals and deletion of covering broad
grants require explicit confirmation. The inline **Runs in browser** label is derived
from actual editor/runtime contributions and remains visible with the master off.

Explicit runtime access requests appear in a framework-owned dialog for an eligible
session. **Review later** keeps the request pending and defers automatic
opening of that ID in the session; the review entry remains available. **Deny**
persists a decision. Approval and the master choice are separate: storing approval
while the master stays off does not start access. Settings drafts and the Note
save owner remain mounted through permission review and affected server reloads.
Conflicts retain permission choices for refreshed review; uncertain writes read
authoritative status before an explicit retry and do not free an unresolved wire
slot or authorize session handoff.

Pending requests, including those postponed with **Review later**, appear in the
Settings sidebar's **Needs attention** section. These are decision-layer buttons,
not settings pages: opening one preserves the current page, tab, drafts and URL
without running page departure. The expanded Plugins row points to the same item
and manual fresh-read opening; plugin pages have no separate permission action.

Another modal or Access wizard postpones automatic opening without deferring,
denying or approving the request. After it closes, a fresh accepted/current
permission read must still match the pending request's plugin, kind, scopes and
source. Failed or superseded loads cannot open a prompt from cached state.

Inventory enablement and auto-enable share one retained policy reservation. An
unresolved wire or unreviewed uncertain choice blocks settings/session departure.
Successful policy persistence is recorded before catalogue refresh; a failed or
superseded refresh requires explicit Review, not another write. Review never
rebases/replays automatically. A fresh enabled:true choice is a new operation that
may rebuild owners, even if a read-back shows equal policy.

| # | Route | Contract |
|---|---|---|
| 1 | `GET /_/api/plugin-host/<id>/permissions` | `PermissionView`, including disabled/failed/settings-less inventory. |
| 2 | `PUT /_/api/plugin-host/<id>/permissions` | `{revision,signature,requestSourceKey,requestSourceRevision,allowNetwork,approvedNetwork,approvedImports}` → `{view}`. New scopes must be requested; omission revokes. |
| 3 | `GET /_/api/plugin-host/permission-requests` | Current vault pending request records. |
| 4 | `POST /_/api/plugin-host/<id>/permission-requests/<request>/decision` | Same control envelope plus `decision:"approve"|"deny"` → `{view}`; deny never grants/enables. |

Mutations use durable namespace-bound revision/content-signature CAS under
`<statePath>/plugin-network/<id>.json`. Malformed/unsupported records retain their
bytes and delegate no authority. Payloads are bounded at 1 MiB. Setup/auth/read-only
gates are inherited. Stale revision/signature/source/request gives 409; malformed
scope gives 422. Durable decision, scheduled reload and actual readiness are
distinct statuses.

Public access may separately enable **Read-only settings**. That policy denies
vault plugin enablement/auto-enable, declarative settings and operator permission
mutations at admission and final commit, including browser SDK/direct HTTP calls.
It does not deny public note writes, commands/endpoints under their existing
authority, plugin-private data or permission request publication, and does not
replace unrelated workflow/browser owners. Browser-local preferences remain
available. The lock cannot unlock itself through Access or setup/reset; recover
through deployment configuration. Read-only note mode still prohibits note writes.

Effective reductions terminate affected old server Workers immediately; accepted
effects are not rolled back or replayed. Metadata-driven expansions return their
SDK admission before waiting for transport receipt and originating
activation/initial-sync/invocation settlement to replace the affected roles.
Unrelated server owners and browser/editor instances are retained. Required guard
replacement can safely reject an in-flight action; that is not saved success.

## Guarantees and limits

Server Worker readiness requires two independent host-owned prerequisites:
completed initialization and an accepted heartbeat from the current generation.
Initialization includes service activation/endpoint/required-guard validation, or
the actual initial render `onSync` (including its awaited SDK RPCs). Every render
replica and admitted replacement qualifies independently; the demanded pool stays
unavailable until all its owners qualify. Duplicate ready descriptors cannot rerun
initial sync or restart grace, and retired/stopping owners cannot publish readiness.

One 10-second slot startup budget, in observed time (below), begins immediately
before Worker construction. Both prerequisites must finish strictly before that deadline;
continued heartbeat traffic cannot keep unfinished initialization alive. This bound
does not include earlier policy reads or later final runtime/manager policy checks.
Startup SDK RPC admission and replies remain available before readiness: accepted
deferred actions return their request IDs promptly but execute only after successful
combined readiness. Failed activation/disable aborts unstarted effects without replay.
Permission admission similarly returns before receipt/origin/readiness settlement;
replacement waits outside the SDK call. Required guards retain their independent
operation/per-plugin deadlines and fail closed while awaiting readiness.

At qualification, one 3000 ms steady window starts without falsifying the actual
heartbeat receipt timestamp. Thereafter only accepted heartbeat receipts refresh
monitoring. Workers heartbeat every 250 ms; the host watchdog keeps the same
cadence and fails a Worker at a silence of strictly more than 3000 ms (twelve
heartbeat periods; 3000 is allowed, 3001 fails when observed), with no retry.

Every liveness and deadline budget is measured in *observed time*, the time in
which the globnotes process was actually running: heartbeat silence, the startup
budget, invocation, guard and operation deadlines, disposal, permission transport
receipts, plugin filesystem deadlines and request-body acquisition. The host clock
ticks every 250 ms. A gap between ticks longer than 350 ms (one period plus 100 ms
of tolerance) is a stall of the process — a paused VM, a starved NAS, swap-in, or
the server's own synchronous work — and only 350 ms of it counts. A hung or silent
Worker is still failed at the same bound while the host runs on time; a stall of
the whole process no longer fails healthy Workers or rejects operations. Stalls of
750 ms or more are logged as warnings (at most one line per 10 s, with a count of
the rest); a heartbeat that arrives after a long gap is logged with the Worker's
own reported timer lateness. Observed time is monotonic, so wall-clock jumps do not
change these budgets either. Credential expiry stays on the wall clock. A Worker
that is silent while the host's timers run on time — its thread starved, or its
messages delivered late — is still treated as silent.

Browser foreground note saves use a per-edit-session FIFO; every admitted Save
has its own immutable content/path snapshot and server operation opportunity.
Acknowledgement is distinct from current cleanliness. Failed or uncertain work
pauses later snapshots without automatic retry, skip or coalescing. A late reply
cannot authorize a handoff that already aborted. See [Saving notes](saving.md)
for activity feedback, pending-work protection and the retained paused state.

- Guarded operations are pre-commit conflict detection, **not** filesystem
  CAS or multi-file transactions; partial storage failures publish verified
  completed facts plus `operation_partial`, never fabricated success.
- A stale access-policy epoch rejects with 409 `operation_conflict` after
  current authorization succeeds — clients must not auto-retry.
- Private means withheld from public/browser APIs and isolated by the
  mediated contract — not cryptographic isolation from a privileged legacy
  plugin.
- Browser modules are trusted same-origin code, not sandboxed like the
  Deno Workers.
- The v3 custom settings renderer seam is designed (stable page IDs,
  renderer kind/version, data/lifetime contract) but only `declarative-v1`
  loads in v2.
