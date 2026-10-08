# Plugin API

globnotes' plugin platform is a single generic model: one plugin can
contribute rendering/editor extensions, lifecycle hooks, commands,
declarative settings pages, and sandboxed HTTP endpoints through supported
host interfaces. Enablement, plugin configuration and plugin data belong to
the **vault** (following Obsidian's ownership model); theme/keybindings stay
browser preferences.

## The default: `on-*` hooks

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

## Facades

| Surface | Contract |
|---|---|
| `ctx.hooks.on(name, handler)` | declared `on-*`/`pre-*`; returns a disposer |
| `ctx.commands.register(def, handler)` | namespaced command; no overriding built-ins or other owners |
| `ctx.settings.read()/subscribe(fn)` | effective validated values; committed-change notifications |
| `ctx.data.load()/save(values, revision)` | private JSON with revision CAS; never in the settings catalog |
| `ctx.actions.request(action, args)` | acceptance-only `{ requestId }`; outcome via `ctx.actions.result(id)` / `onResult` |
| `ctx.files.read(path)` / `ctx.files.requestWrite(path, bytes)` | grant-checked mediated file access; guarded `file-write` action |
| Server `ctx.permissions.declare({network,imports}, options?)` | complete host-bound contributor/source request snapshot; cannot grant access |
| Server `ctx.permissions.requestAccess({kind,hosts,reason}, options?)` | prompt admission `{requestId,revision,status,blockedReasons}`; does not wait for a human or grant traffic |
| Server `ctx.permissions.status()` | owning current request/approval/effective projection and source token |
| `ctx.register(disposer)` / `ctx.timers` | generation-scoped cleanup, even when disposal throws |
| Browser: `ctx.events.on` / `ctx.actions.dispatch` | managed bus facts/actions; admission is not completion |

### Settings persistence and definition changes

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

Open **Settings → Plugins → Review permissions** to inspect a plugin's server
requests and remembered approvals. Every discovered plugin also has a framework
**Server permissions** page, including disabled and settings-less plugins. The
same controlled panel is used for review and settings. Network data and remote-code
imports have separate rows; All hosts approvals and deletion of covering broad
grants require explicit confirmation. The **Runs in browser** badge is derived
from actual editor/runtime contributions and remains visible with the master off.

Explicit runtime access requests appear in a framework-owned dialog for an eligible
session. **Cancel / Review later** keeps the request pending and defers automatic
opening of that ID in the session; the review entry remains available. **Deny**
persists a decision. Approval and the master choice are separate: storing approval
while the master stays off does not start access. Settings drafts and the Note
save owner remain mounted through permission review and affected server reloads.
Conflicts retain permission choices for refreshed review; uncertain writes read
authoritative status before an explicit retry and do not free an unresolved wire
slot or authorize session handoff.

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
