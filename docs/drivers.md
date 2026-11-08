# Sync driver author guide

A sync driver is a plugin contribution, running in one sandboxed Deno Worker
per configured instance. Each instance is one vault peer. Two instances of the
same plugin have separate settings, keys, progress and failure state. The hub
owns all vault writes and conflict decisions. A driver describes its endpoint,
provides requested bytes and applies exports to its endpoint; it never writes
the vault folder or keeps a private copy of it.

The complete TypeScript contract and strict validators live in
[`server/plugins/driver_contract.ts`](../server/plugins/driver_contract.ts).
Driver API **1** is separate from plugin contract 2. See
[plugin-api.md](plugin-api.md#sync-driver-contribution-driver-api-1) for the
instance control routes, network consent and Worker ownership.

## Declare the contribution

```json
{
  "id": "my-sync",
  "name": "My storage",
  "capabilities": { "network": ["storage.home"], "imports": false },
  "driver": {
    "entry": "driver.js",
    "apiVersion": 1,
    "settings": [
      { "key": "url", "label": "Remote URL", "type": "text", "default": "" }
    ],
    "secrets": [{ "key": "token", "label": "Access token" }],
    "capabilities": {
      "discovery": { "snapshot": true, "delta": false },
      "revisions": "exact",
      "mutations": {
        "create": "conditional", "update": "conditional",
        "delete": "conditional", "move": "none"
      },
      "groups": "none",
      "history": { "baseText": false },
      "limits": { "maxBatch": 64 }
    }
  }
}
```

The id matches its plugin directory; entry is a contained basename. Unknown
manifest/capability properties and unsupported API versions fail validation.
Settings use the existing declarative-v1 field types, as one per-instance page,
without filesystem grants. Declare at most eight secret keys, matching
`^[a-z][a-z0-9_]{0,31}$`. Never put a token or passphrase in ordinary settings.

Each declaration accepts `required?: boolean`: omitted or `true` keeps the
pre-Worker lock when unset. Use `required:false` for backend-specific credentials
or optional encryption. The flag is preserved in catalog and key-status views;
it does not change declaration-bound, per-instance secret RPC authorization.
Validate the selected configuration in provider `identity()` (called by SDK
`open()`), before endpoint I/O. A missing needed optional key throws
`new ctx.driver.StorageError("unauthorized", {effect:"none",message:"needs Password"})`:
the SDK returns typed `open(): locked`, never an empty remote. Defer lookup until
open, rather than failing activation. Irrelevant optional keys may remain absent.

Capabilities are static and inspectable without running code. Snapshot discovery
is required; delta is optional. Revisions are `exact` or `none`. Each mutation
declares `conditional`, `emulated` or `none`; move is `native` or `none`.
Groups are `atomic` or `none`; historical base text is explicitly advertised.
Do not promise native conditions or group atomicity your provider cannot supply.
The driver contribution grants sync of every tracked vault file through the hub,
including dotfiles, except canonical host state and staging files. It does not
use `capabilities.write`. Ignore rules belong to the driver.

## Worker context and lifecycle

```js
export function activate(ctx) {
  const driver = ctx.driver.storage(createProvider(ctx), { name: "My storage" });
  ctx.driver.serve(driver);
}
```

The frozen context contains `createUuid`, frozen `instance: {id,label,settings}`,
`secrets.get(key)`, `driver.serve`, `driver.hint`, `driver.storage`,
`driver.StorageError`, managed `timers` and `register`. Secret lookup is an RPC
for a declared key of this exact instance/generation, not an initialization
payload. Missing required keys prevent Worker construction. There are no note,
file, data, hook, command, endpoint, permission or versioning facades.

Call `serve` once with all five methods. Functions stay in the Worker:

| # | Method | Input and result |
|---|---|---|
| 1 | `open()` | Once per generation: `{state:"ready",endpoint:{id,epoch},scope}`, `{state:"locked",reason}` or `{state:"failed",error}` |
| 2 | `discover({mode,cursor?})` | A bound snapshot/delta page as below |
| 3 | `read({path,revision})` | Known bytes at that exact revision, absence, unknown or locked |
| 4 | `apply(items)` | Exactly one typed receipt for every item id |
| 5 | `close()` | Release resources; return no data |

`hint()` asks the host to run discovery; it neither writes files nor supplies
observations. The host coalesces requests, debounces hub-triggered export by one
second, discovers every 60 seconds and never overlaps cycles of one instance.
Different instances progress concurrently, serializing only their vault effects.
Retry uses observed process time: five seconds doubling to five minutes, honoring
longer provider advice. A process stall does not consume the full deadline.

The Worker can read its code and host-shared modules, with the plugin's effective
approved network/import scopes. Raw vault/state reads, writes, environment,
subprocesses, FFI and system access are denied. Disable, access changes, network
reductions, instance/key changes and shutdown fence old generations. A lost
invocation reply does not establish that an endpoint write failed.

## Observations and failures

An endpoint id names the native storage relationship; epoch names its
incarnation. Change the epoch when the endpoint is replaced/reset. Scope is a
stable fingerprint of the driver's own filters and name mapping. These are
metadata, never keys or file bodies. Native revision tokens must be opaque,
at most 512 UTF-8 bytes, and must not embed paths: they can survive a deletion.

```ts
type DiscoveryPage = {
  endpoint: { id: string; epoch: string };
  scope: string;
  mode: "snapshot" | "delta";
  entries: Entry[];
  groups?: { id: string; members: string[] }[];
  cursor?: string;
  completion: "more" | "complete" | "incomplete";
  error?: DriverError; // valid only on incomplete pages
};
```

| # | Entry | Meaning |
|---|---|---|
| 1 | `{state:"known",path,revision,size?,group?}` | A readable file at a native revision |
| 2 | `{state:"absent",path,proof:"native-delete"}` | An explicit native deletion, delta only |
| 3 | `{state:"unknown",path?,reason}` | Could not check; never absence |
| 4 | `{state:"excluded",path}` | Driver filter detaches this path without deleting it |
| 5 | `{state:"locked",path?,reason}` | Missing/rejected key or unreadable encrypted state; no deletion or export |

`read` returns `{state:"known",revision,bytes:Uint8Array,baseText?}`,
`{state:"absent"}`, `{state:"unknown",reason,error?}` or
`{state:"locked",reason}`. Current-only stores must refuse a changed revision,
not attach a requested old token to today's bytes. Base text is permitted only
with `history.baseText:true`, must actually be available from native history,
and is used then forgotten by the hub.

`DriverError` is `{code,retryAfterMs?,message?}`, with code `offline`,
`rate_limited`, `denied`, `network_denied`, `invalid` or `internal`. Advice is
nonnegative integer milliseconds. Typed error fields on incomplete discovery
and unknown reads preserve failure/retry information through strict Worker
validation. They do not turn failure into absence or advance the cursor.
Authentication failure locks; sandbox `network_denied` fails with a link to
plugin permission controls. Exceptions carry no arbitrary diagnostic payload.

The host requires all pages to match the opened endpoint/epoch/scope and mode.
It validates every message, including cross-page duplicate paths/cursor cycles.
Malformed results fail that instance with `driver_contract_violation` before
their data is applied. Canonical state, directory/symlink targets and NFC disk
spelling collisions are checked at the hub boundary; unsafe targets are listed
as per-path invalid issues and never applied or exported.

## Export items and receipts

```ts
type ExportItem = {
  id: string; op: "put" | "delete"; path: string; batch: number;
  bytes?: Uint8Array; // put only
  base: { revision: string } | { absent: true };
  from?: string; // only when native move is declared
};
```

| # | Receipt | Meaning |
|---|---|---|
| 1 | `{id,state:"settled",revision?}` | Accepted native effect; put requires its new revision |
| 2 | `{id,state:"conflict"}` | Endpoint no longer matches the supplied base |
| 3 | `{id,state:"uncertain"}` | May have committed; must be observed before replay |
| 4 | `{id,state:"failed",error}` | Known failure with typed advice |
| 5 | `{id,state:"excluded"}` | Detached by this driver's rules |
| 6 | `{id,state:"unsupported",reason}` | Cannot represent this file/name/operation |

The host pins current outgoing bytes for one invocation and rechecks their hash
before dispatch. Superseded bytes are not kept in an outbox. A receipt acknowledges
what that endpoint holds, not authorship. Equal hub/mapping versions produce no
export, including the driver's own imports. On conflict, discover the endpoint's
change before trying the reconciled export. On uncertainty, equal read-back
settles without another write; differing unconfirmed bytes preserve an alternative.
Packet results can be partial. Retain each preceding receipt when another item
fails; do not throw away evidence that an earlier effect committed.

## Storage-provider SDK

[`tests/fixtures/plugins/globnotes-test-driver/driver.js`](../tests/fixtures/plugins/globnotes-test-driver/driver.js)
is the complete test-only reference provider. It uses authenticated HTTP, random
ETags, explicit native conditions, filters and name validation. The SDK owns
storage adaptation, while the hub remains the only reconciliation owner.

| # | Provider member | Contract |
|---|---|---|
| 1 | `identity()` | Promise of `{id,epoch}` after authenticated endpoint identification |
| 2 | `list(cursor?)` | Promise of `{entries:[{key,size,etag}],next?}`; at most 1000 per page; omit next only after a complete listing |
| 3 | `get(key)` | Promise of `{bytes:Uint8Array,etag}`; not-found is a typed error |
| 4 | `put(key,bytes,{ifMatch?,ifNoneMatch?:"*"})` | Promise of `{etag}`; preserve the condition, report unknown effects honestly |
| 5 | `delete(key,{ifMatch?})` | Promise of void after conditional deletion |
| 6 | `conditions:{create,update,delete}` | Explicit booleans for actual native condition support, captured at SDK construction |
| 7 | `exclude?(path)` | True detaches an item, never deletes it |
| 8 | `scope?()` | Stable filter/name/root fingerprint, default `"all"` |
| 9 | `name?(path)` | `{ok:true,key}` or `{ok:false,reason}`; never lossy renaming |

Listing keys are canonical vault paths. A provider with encoded native names
decodes them in `list` and maps them back through `name` for object I/O. A prefix
or backend root is a provider detail, not a second hub namespace. Preserve NFC
identity and case, and reject unrepresentable names instead of making them fit.

Throw `new ctx.driver.StorageError(code,{effect,retryAfterMs?,message?})`, with
code `unauthorized`, `forbidden`, `not_found`, `precondition_failed`,
`rate_limited`, `unavailable`, `network` or `invalid`. Effect is mandatory:
`none` only when no write happened, otherwise `unknown` if the reply was lost.
The SDK maps 404 reads to absent, precondition failures to conflict and uncertain
mutation effects to uncertain. Untyped mutation transport failures are uncertain
too. Auth errors lock and stop subsequent sends; advice survives open, discovery,
read and mutation results. Sandbox denial remains distinct from endpoint auth.
`StorageError` normalizes provider messages once: valid UTF-8, no NUL, at most
4096 bytes without splitting a code point, and the error code when no text
remains. Empty responses and oversized proxy error pages therefore preserve
their typed lock/retry outcome instead of violating the Worker contract.

For missing native conditions, declare the corresponding manifest mutation
`emulated`. The SDK freshly checks the supplied base immediately before the
write; this is inherently racy. It refuses activation if provider support is
weaker than a declared `conditional` promise. `none` never invokes that provider
mutation. The instance discloses:

> This storage cannot check versions while writing; a change made there at the
> same moment can be overwritten.

Do not hide a backend's limitations behind a conditional manifest. A basic
storage provider has no history and no atomic multi-object operation; its
manifest declares `groups:"none"` and `history.baseText:false`. Native protocols
implement the lifecycle directly when they need atomic groups, delta feeds or
native history. The separate test-only `native.js` fixture demonstrates those
contract boundaries, not a capability of the basic provider interface.

## Safety, groups and resource limits

Unknown is never absent. Omission implies deletion only after an entirely
complete, comparable snapshot with no unknown/locked observations. Delta omission
proves nothing. An endpoint that suddenly looks empty infers no deletions and
requires an explicit instance decision. Changed endpoint/epoch reboots mappings,
adopting equals and preserving collisions, never deleting either side. Scope
changes detach exclusions and forbid omission deletion for that pass.

The hub keeps only metadata: per-peer keyed path hashes, native revisions,
acknowledged hub versions, delivery states and cursors. A deleted-here note never
silently returns: an unchanged remote version is deleted there; a different one
is held for explicit Restore here or Delete there. Deleted names are transient;
after restart a nameless obligation waits for discovery to supply its name.

| # | Bound | Outcome |
|---|---|---|
| 1 | Paths: 4096 UTF-8 bytes, vault relative, slash separated, no empty/dot/parent segments, staging names or backslashes | Invalid names are never materialized |
| 2 | Discovery: 1000 entries and 1 MiB metadata per page | Malformed/oversized result fails the cycle |
| 3 | Read: 16 MiB bytes; historical text separately bounded to 16 MiB | Larger files are unsupported, never truncated/deleted |
| 4 | Apply: manifest maxBatch 1-64, combined bodies at most 16 MiB | Ordered split with visible group_split notice when necessary |
| 5 | Import unit: 256 files and 64 MiB | Ordered bounded parts with visible group_split; preceding committed parts remain truthful after failure |
| 6 | Observed deadlines: open/discover/close 30 s; read/apply 120 s | Read loss is unknown; apply loss is uncertain |

All bodies of one ready import unit are acquired before its first effect. One
managed operation revalidates versions under the note lock/commit gate, writes
attachments before notes and deletions last, and publishes one hub batch. A
conflicting member becomes a sibling conflict copy; uncontested members still
land. Cooperative hub readers, index and browser stream see the complete batch.
Outside programs can observe individual filesystem effects: this is not a
filesystem transaction or kernel CAS. A crash between effects and recording is
reconciled by the scanner; the next import adopts equal bytes. There is no
rollback over newer outside changes and no retained content journal.

Outgoing items retain their hub batch. A native atomic driver publishes a whole
fitting batch in one native unit. Oversized batches split at the documented bounds;
ordinary storage puts/deletes never acquire fictional multi-object atomicity.

## Conflicts, keys and deployments

Equal bytes are adopted. A changed endpoint replaces a still-matching mapped
hub version. When both sides changed, verifiable historical base text can merge
Markdown. Without an available base, the hub keeps a sibling conflict copy,
`<stem>.conflict-<UTC>-<instance-id>.<ext>`, reason stale-base. First-sync collisions
are unknown-base ("Different on both sides"). No API manufactures a base from
timestamps, ETags or arrival order. The hub stores neither old text nor patches.
Native remote history and optional versioning plugins have separate retention.

Service plugins can opt into [changes API 1](plugin-api.md#acknowledged-log-facts-changes-api-1)
for acknowledged facts from local observations, editor/API writes, plugin writes
and driver imports. An import's peer remains its instance id; adoption/export
acknowledgement never invents another author. This feed has explicit gaps and
current metadata snapshots, not retained historical bodies or preimages. A
versioner/RAG consumer must verify current-read hashes and supply any historical
completeness from its own source history. Existing operation hooks and backup
delivery remain separate contracts.

Service-side consumers can also use [current parsed metadata](plugin-api.md#current-note-metadata)
get/query/watch for properties, links, headings, tasks and inline fields. The
per-vault projection follows these same all-peer facts without persistent parsed
content; narrow ordinary read grants are sufficient. It is current-state parsing,
not driver history or a RAG archive. Driver-role Workers do not receive that facade.

Keys are server-held per instance in mode-0600 `driver-secrets.sqlite` in the
configured state directory, with secure delete and no WAL. Reads disclose only
declaration/set/time; there is no key GET. Raw, URI-encoded and base64 forms are
redacted from driver state/errors. Driver console values and arbitrary exceptions
are not forwarded. Clearing/removal fences the old Worker and deletes key rows.
Removal never deletes vault or endpoint files.

Key entry and ordinary workflows work on local-domain plain HTTP, without a
browser secure context. Off a trusted LAN, use a TLS reverse proxy such as Caddy
or Nginx Proxy Manager to protect the link. When state lives inside the vault,
the instance view names its path and explains that outside whole-folder copies
include keys. Keep state outside such copies using `GLOBNOTES_INDEX_PATH`.

The shipped [Remotely Save driver](../plugins/globnotes-remotely-save/README.md)
is a production storage-SDK example: S3-compatible/WebDAV transports, bounded
native-name mapping and plaintext/OpenSSL/rclone codecs remain inside the plugin.
It declares emulated conditions and no historical base text. Its optional keys
are validated against the selected backend/codec in open, before network I/O.
The hub still owns every reconciliation and folder effect.

Production Git/BEP/LiveSync/FUTO drivers, driver-private storage and chunked
transfer above 16 MiB are separate work. A driver that decrypts is trusted with
plaintext and its instance's key; encryption of its endpoint does not encrypt
the hub's live folder or other peers.
