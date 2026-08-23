# globnotes plugin authoring

A globnotes plugin is a folder with a `manifest.json` and an ES-module entry.
It runs **sandboxed** in its own Deno Worker and hooks into the markdown-it
render pipeline.

## Layout

```
<vault>/.globnotes/plugins/my-plugin/
├── manifest.json
└── main.js
```

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
  - `network`: `false` (default), `true`, or a list of allowed hosts —
    also gates remote `import` specifiers
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

| Method | Returns |
|---|---|
| `ctx.search(term)` | `SearchResult[]` (FTS5 search over the vault) |
| `ctx.readNote(title)` | `Note` (`{ title, content, lastModified }`) |
| `ctx.listTitles()` | `string[]` of all note titles |
| `ctx.readFile(path)` | `{ mediaType, body: Uint8Array }` |
| `ctx.pathPrefix()` | the configured `GLOBNOTES_PATH_PREFIX` (`""` if unset) |

## Ordering and disabling

`<vault>/.globnotes/plugins.json`:

```json
{
  "order": ["my-plugin", "globnotes-autolinks"],
  "disabled": ["globnotes-mermaid"]
}
```

Listed ids run first (in listed order); the rest keep discovery order;
disabled ids are dropped. The settings UI (menu → Plugins) stores
per-browser switches in localStorage and passes disabled ids with each
render request.

## Rules of the sandbox

- A plugin that throws **abstains** — it can degrade a render, never kill it.
- A hung Worker is terminated and respawned (250 ms heartbeat, 3×T silence).
- Workers are reinstantiated on every sync; `onSync` is where cache-like
  state gets rebuilt.
- Permissions are real: `Deno.env`, `Deno.readFileSync` outside the
  declared paths, and network calls (without the capability) all throw
  `PermissionDenied` inside the Worker.
