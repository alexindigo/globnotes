# globnotes plugin authoring

A globnotes plugin is a folder with a `manifest.json` and an ES-module entry. It
runs **sandboxed** in its own Deno Worker and hooks into the markdown-it render
pipeline.

## Layout

```
<vault>/.globnotes/plugins/my-plugin/
├── manifest.json
└── main.js
```

(With `GLOBNOTES_INDEX_PATH` set, the state dir replaces `<vault>/.globnotes`
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
- `capabilities` map directly onto the Worker's Deno permissions:
  - `network`: `false` (default), `true`, or a list of allowed hosts — also
    gates remote `import` specifiers
  - `read`: `["vault"]` by default; `"vault"` expands to the vault root
  - `write`: `[]` by default
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
  // Optional: fired after every note sync (plugins are reinstantiated on
  // every sync — keep no state you can't rebuild here).
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
| `ctx.pathPrefix()`   | the configured `GLOBNOTES_PATH_PREFIX` (`""` if unset) |

## Ordering and disabling

`<vault>/.globnotes/plugins.json` (or `<state dir>/plugins.json` when
`GLOBNOTES_INDEX_PATH` relocates state):

```json
{
  "order": ["my-plugin", "globnotes-autolinks"],
  "disabled": ["globnotes-mermaid"]
}
```

Listed ids run first (in listed order); the rest keep discovery order; disabled
ids are dropped. The settings UI (menu → Plugins) stores per-browser switches in
localStorage and passes disabled ids with each render request.

## Rules of the sandbox

- A plugin that throws **abstains** — it can degrade a render, never kill it.
- A hung Worker is terminated and respawned (250 ms heartbeat, 3×T silence).
- Workers are reinstantiated on every sync; `onSync` is where cache-like state
  gets rebuilt.
- Permissions are real: `Deno.env`, `Deno.readFileSync` outside the declared
  paths, and network calls (without the capability) all throw `PermissionDenied`
  inside the Worker.

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
