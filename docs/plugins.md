# globnotes plugin authoring

A globnotes plugin is a folder with a `manifest.json` and optional ES-module
entries. Server code runs **sandboxed** in Deno Workers; browser code runs as
trusted same-origin code. Plugins can extend rendering, editing and app workflows.

## Layout

```
<vault>/.globnotes/plugins/my-plugin/
├── manifest.json
└── main.js
```

(With `GLOBNOTES__METADATA_PATH` set, `<metadata>/<vault name>` replaces `<vault>/.globnotes`
in every path below.)

Two roots are scanned (internal first, vault overrides by ID):

- `<repo>/plugins/<id>/` — built-ins shipped in the image
- `<vault>/.globnotes/plugins/<id>/` — yours

## manifest.json

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "license": "LGPL-3.0-only",
  "capabilities": {
    "network": false,
    "write": [],
    "read": ["vault"]
  }
}
```

- `id` **must match the directory name** (hard error otherwise).
- `entry` defaults to `main.js`.
- Server-Worker network declarations are requests, not grants:
  - `network`: `false` (default), `true`, or an exact host/port list requests
    data-network access.
  - `imports`: the same shape independently requests remote-code imports.
    Omission retains the legacy network-derived **request intent**, not approval;
    use `imports:false` for an explicitly network-only plugin.
  - Effective network/import rights require the per-plugin master, remembered
    host-owned approval and already-granted parent authority. The default is denial.
  - These controls apply to server Workers. Trusted browser/editor code and browser
    network loads from rendered content are outside this boundary.
- Filesystem capabilities:
  - `read`: `["vault"]` by default; `"vault"` expands to the vault root
  - `write`: `[]` by default; the paths a server plugin's actions and
    `ctx.files.requestWrite` may write (plugin contract 2: no Worker writes files
    directly, and every write states its base, see [plugin-api.md](plugin-api.md))
  - `env`, `ffi`, `run`, `sys` are always `false`

## main.js

```js
export function getSelectors() {
  return [{ node: "fence", language: "mermaid" }];
}

export function parseNode(node, ctx) {
  // Return ONE of:
  //   null                       → abstain; the next plugin (or the default
  //                                renderer) handles this node
  //   { parts: ["<b>..</b>"] }   → HTML fragments; node is consumed
  //   { node: { content: ".." } } → node descriptor; matching RE-ENTERS
  //                                downstream plugins only (forward-only)
}

export function onSync(ctx) {
  // Optional: initial sync and later note syncs reach each render replica.
  // Ordinary sync retains the same Workers and their module state.
}
```

### The node descriptor

```ts
{
  type: string;           // "fence" | "blockquote" | "inline" | "text" | …
  tag: string;            // html tag for containers ("blockquote", "p", …)
  info: string;           // fence info string ("js", "mermaid", …)
  content: string;        // raw source content (fence body, text content)
  text: string;           // plain text of the whole subtree
  childrenHtml: string;   // default-rendered children (containers, inline)
  attrs: [string, string][];
}
```

### Selector grammar

Plugins declare; the host pipeline evaluates. First match per node wins.

```js
{ node: "fence", language: "mermaid" }              // fence + info
{ node: "blockquote", params: { has: "[!" } }       // text contains
{ node: "text", params: { hasAny: ["[[", "#"] } }   // any of
{ node: "text", params: { eq: "exact" } }           // full equality
{ node: "inline" }                                  // type only
```

### The `ctx` back-channel

Async RPC to the host (values are structured-cloned):

| Method               | Returns                                                |
| -------------------- | ------------------------------------------------------ |
| `ctx.search(term)`   | `SearchResult[]` (FTS5 search over the vault)          |
| `ctx.readNote(path)` | `Note` (`{ path, content, lastModified }`)             |
| `ctx.listPaths()`    | `string[]` of all note paths                           |
| `ctx.readFile(path)` | `{ mediaType, body: Uint8Array }`                      |
| `ctx.pathPrefix()`   | the configured `GLOBNOTES__SERVER_PATHPREFIX` (`""` if unset) |

## Ordering, enablement and the generic platform

The v3 [configuration boundary](configuration.md#plugin-deployment-pins)
keeps saved policy beneath explicit TOML/env pins. Addressed JSON uses existing
manifest page/field validation, including inactive installed plugins, before
Workers start. TOML and env pins share source fingerprints, schema leases,
secret redaction and approval handling; they do not create new saved copies.
Production startup uses this vocabulary.

`<state dir>/plugins.json` is vault policy: `order`, `disabled`, `enabled`,
`autoEnable` and `revision`. Explicit disabled wins over explicit enabled,
which wins over the auto-enable default (a stated
`GLOBNOTES_GLOBNOTES_PLUGINS_AUTOENABLE` pins that default and is shown as such in
Settings). The host Settings modal (gear, bottom-right) owns
inventory/enablement for every browser of the vault; legacy per-browser
switches in localStorage remain old preferences only and are never promoted
into vault policy.

In public access, **Read-only settings** can lock these vault-owned controls and
operator approvals while leaving note editing and local theme/keybinding/editor
preferences available. Existing workflow owners, private data and request
publications retain their normal authority. Locked settings cannot unlock
themselves in the UI/API; deployment configuration owns recovery. Read-only note
access remains a separate policy that also prohibits note writes.

Vault disable retires render owners and service admission before asynchronous
cleanup. Explicit re-enable rediscovers installed server code and can create
fresh owners even when the manifest version is unchanged; unrelated plugins keep
their owners. Render pools stay lazy until rendering is first requested.

This is not an automatic on-disk hot-reload system. Ordinary rendering/index
sync retains unchanged owners. Installed-code mismatch is exposed as
`source-reload-required` by the owning permissions status, and old-code runtime
permission publications cannot claim the replacement's source token. Use explicit
enablement/source replacement to consume changed server code. Settings-source
changes retire obsolete runtime intent and immediately fence any reduced raw
authority at the settings commit. Same-code recovery is limited to affected roles
and narrowed rights; unchanged owners continue using the fresh-token declaration
flow. Approvals/master choices, unrelated owners and render laziness are retained.
A replacement's reported readiness requires its actual demanded renderer to be ready.

Server-mediated note/file/list/search/resolver reads project declared grants and
exclude the canonical host state directory, including state relocated into a
visible vault folder. Legacy explicit raw filesystem grants remain a separate
direct-access boundary.

Settings schema updates retain removed fields/pages in private storage while reads
expose only the current schema. Current-field writes preserve that removed data;
reintroducing compatible fields/pages restores their saved values. Existing current
values that violate their declared type/constraints fail visibly, without coercion.
Retained data still counts toward the existing storage-size bound.

The full generic platform contract — runtime entries, `on-*`/`pre-*` hooks,
commands, declarative settings pages, sandboxed endpoints, data persistence
and guarantees — is documented in [plugin-api.md](plugin-api.md).

Each plugin that declares settings has one **Open settings** action in its
**Settings → Plugins** row and one entry under **Plugin settings**. Multiple declared
pages appear as tabs in declaration order. For example, **Versioned note backups**
opens its **Backups** page. **Manage in Plugins** returns to the expanded owner row. Pages remain
discoverable for disabled plugins and valid declarations whose runtime failed;
the existing host-owned availability and draft-recovery controls still apply.
Settings-less plugins have no invented settings action.

## Sync plugins and instances

A plugin may declare a `driver` contribution ([driver author guide](drivers.md)).
Its Plugins row discloses: "Sync driver: reads and writes every file of this vault
through the hub". Driver instances have no direct vault filesystem access; each
has its own sandboxed Worker, configuration and write-only keys. Network consent
is still per plugin and is managed in that plugin's expanded row.

Open **Settings -> Sync**, choose **Add**, select an enabled sync plugin and name
the instance. New instances are off. Review its settings, save its keys and switch
it on. Multiple instances of one plugin are independent peers. Sync now requests
a full cycle; Off/Starting/Active/Locked/Failed/Paused describe its current state.
Plain local-domain HTTP supports the entire workflow. The memory-remote driver
lives only in test fixtures. The shipped Remotely Save plugin connects existing
S3-compatible or WebDAV stores; see its [setup and compatibility guide](../plugins/globnotes-remotely-save/README.md).

For Remotely Save, match the existing backend, exact remote prefix/base directory,
addressing/authentication choice and encryption mode. Configure the instance while
off. Enter the selected backend's credentials and, for OpenSSL or rclone, its
encryption password under Keys. Irrelevant optional keys may remain unset; a
missing needed key locks the instance instead of treating the remote as empty.
OpenSSL reads old base32 names as well as base64 names; no mode converts a store.
The driver preserves reserved legacy metadata, folder markers, case and dotfiles.
Storage has no historical base text: collisions become copies in the hub inbox,
not timestamp-selected overwrites. The 16 MiB plaintext and native-name limits,
upload-time behavior and simultaneous-write limitations are in the plugin guide.

Settings drafts use explicit Save settings or Discard edits. Leaving Settings or
changing pages asks before losing local work; unknown requests must settle and be
reviewed before retry or departure. Password inputs clear after their owned PUT
settles, preserving newer input; key values never enter browser storage, history
snapshots or bus facts. A read returns only Set/Not set and update time.

Deleted-here remote changes require Restore here or Delete on the remote, per file
or for all held items. A remote that suddenly looks empty deletes nothing until
Delete here too or Upload them again is chosen. Unsupported/invalid files remain
listed with their reasons. Revision checks refuse stale decisions. Collisions
without a known base become neighboring conflict copies; the Conflicts inbox
shows "Different on both sides" and the source instance label. Removing an
instance removes its keys and retires its id, leaving vault and endpoint files.

Providers with emulated conditions disclose the simultaneous-write race in the
instance panel. If state is inside the vault, Sync names the key-store location:
outside tools copying the entire folder copy keys too. Use `GLOBNOTES__METADATA_PATH`
to keep state outside such copies. For connections outside a trusted LAN, protect
the page's link with a TLS reverse proxy such as Caddy or Nginx Proxy Manager.

For server network consent, expand the plugin's row in **Settings → Plugins**.
The inline controls replace the old permission pages and review dialog. Manual filesystem additions are
listed for review; there is no marketplace or new browser activation-review gate.
Network data and remote-code imports need separate approval, and **Allow network**
is a per-plugin master that keeps remembered approvals when off. A prominent notice
and inline **Runs in browser** label disclose trusted editor/browser code;
these server controls do not restrict it or browser loads from rendered content.

## Shipped workflow plugins

The browser-only [Autosave timer](../plugins/globnotes-autosave-timer/README.md)
triggers the normal Save after typing pauses or at a fixed interval. Its Autosave
switch is **off by default**: open **Settings → Plugin settings → Autosave** and
read the warning banner before turning it on. Settings are vault-owned; detecting
changes made elsewhere is planned for v3.

The server-only [versioned backup plugin](../plugins/globnotes-backup/README.md)
uses the legacy best-effort versioning hook: after a save, rename or delete
commits, the host delivers the displaced bytes asynchronously. Saves never wait
for backup processing; a crash before storage can lose the pending version.
Future v3 versioners will follow the hub change log (M5/M7). Settings ->
Versioned note backups → Backups has a default2 / integer1–10 slider and optional base. **Adjacent `.bak`
files remain visible vault files, including old/deleted text for public readers.**
Dedicated bases mirror the captured original path; rename/base changes do not
migrate histories. Generic environment pins and filesystem grants are documented
in [plugin-api.md](plugin-api.md).

## Rules of the sandbox

- A plugin that throws **abstains** — it can degrade a render, never kill it.
- Each service Worker, initial render replica and admitted render replacement
  becomes operational only after initialization **and** its first accepted,
  current-owner heartbeat. Service initialization includes activation, endpoints
  and required guards; render initialization includes the awaited initial `onSync`.
  Both prerequisites share one 10-second startup budget in observed time, from
  just before Worker construction. Neither ready nor heartbeat traffic extends it.
- Qualified Workers heartbeat every 250 ms and fail at a silence of strictly
  more than 3000 ms (twelve heartbeat periods), observed at a host watchdog
  tick. A single steady window begins at combined readiness; thereafter only
  genuine heartbeat receipts refresh it. Failed service registrations are revoked; qualified render failures enter
  the existing admitted replacement flow, without replaying calls. Startup failure
  does not count as a previously healthy render owner.
- Liveness and every plugin deadline use observed time
  (`server/observed_time.ts`): monotonic, and a stall of the globnotes process
  itself (a paused VM, a starved NAS, the server's own synchronous work) counts
  at most 350 ms per 250 ms tick. Healthy Workers are not failed for time in which
  the host was not running; a Worker silent while the host runs on time still is.
  Stalls of 750 ms or more are logged as warnings.
- Render workers keep state across ordinary saves/indexing; legacy `onSync`
  is broadcast to every replica at a serialized sync boundary (this is a
  deliberate change from the old per-sync reinstantiation — plugins that
  relied on per-sync state resets need explicit sync handling).
- Permissions are real: `Deno.env`, `Deno.readFileSync` outside the declared
  paths, any file write, and network calls (without the capability) all throw
  inside the Worker (`NotCapable` or `PermissionDenied`).

## Dual-mode plugins (editor half)

A plugin can ship a **client.js** next to `main.js` and take part in the WYSIWYG
editor, not just the server render. One plugin, two halves:

| Half        | Runs in                                 | Loaded via                               |
| ----------- | --------------------------------------- | ---------------------------------------- |
| `main.js`   | sandboxed Deno Worker                   | render pipeline dispatch                 |
| `client.js` | the browser, inside the Milkdown editor | `/api/plugins` flag → dynamic `import()` |

```
plugins/my-plugin/
├── manifest.json
├── main.js
├── client.js        ← optional editor half (default name)
└── styles.css       ← one stylesheet serves BOTH modes
```

- The entry name defaults to `client.js`; override with
  `"client": { "entry": "panel.js" }` in the manifest. The file's presence on
  disk decides whether the plugin is dual-mode — `/api/plugins` flags those with
  `client: true`.
- `client.js` is served fresh from disk by `GET /_/plugins/<id>/client.js` (same
  no-restart behavior as `styles.css`) and dynamic-imported by the editor for
  every enabled dual-mode plugin. Disabling the plugin skips the import — the
  editor falls back to whatever core renders.

### The client module contract

`client.js` default-exports an **array of Milkdown plugin factories** (`$remark`
/ `$node` / `$view` / `$prose` from `@milkdown/utils`):

```js
import { $view } from "@milkdown/utils";

export default [
  $view(someNode, () => (node) => ({ dom, contentDOM: null })),
];
```

The factories are spread into the editor **after** the core plugins, so a
plugin's `$view` on a core-defined node overrides core's own view for that node.
Toggle changes remount the editor (the same keyed-remount pattern as
keybinding-layer switches).

Bare imports in `client.js` resolve against the **host module registry** — an
import map the app injects, pointing at a `plugin-sdk` chunk that re-exports the
host-owned packages (`@milkdown/core`, `@milkdown/ctx`, `@milkdown/utils`,
`prosemirror-state`, `prosemirror-view`, plus the `@globnotes/frontmatter*`
shared halves). Import from those specifiers directly — never bundle your own
copy of host packages, or the plugin's factories would operate on different ctx
slices than the editor. (This is the browser-native equivalent of Grafana's AMD
registry and Obsidian's host-provided `obsidian` module.)

Reference implementation: `plugins/globnotes-properties/` — the Properties
panel. Its server half claims the `front_matter` token and emits structured
markup; its client half overrides the core frontmatter node's read-only fallback
view with the interactive panel (inline key and value editing, chip lists with
vault-tag autocomplete, `+ Add property`, and an empty-state affordance that
creates the block at position 0). One `styles.css` styles both halves — the
WYSIWYG wrapper carries the same `.toastui-editor-contents` class as view mode.

Core owns file-format integrity: the frontmatter node (schema, position-0
parser, YAML serializer) lives in the editor core, NOT in the plugin, so a
disabled plugin degrades the editor to a framed read-only view and never
corrupts the file.
