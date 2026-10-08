# Event bus

globnotes uses a lightweight, mitt-based client-side event bus so
components can react to facts without importing each other.
Publishers announce what happened; consumers decide what to do.

## Architecture

```
client/bus/index.js    —  mitt wrapper (subscribe / publish)
client/bus/topics.js   —  topic constants + payload docs
```

`subscribe(topic, handler)` returns an `unsubscribe` function.
`publish(topic, payload)` delivers the payload to every subscriber
on that topic. Unknown topics are silently ignored (mitt has no
schema enforcement — the topics.js file IS the contract).

## Conventions

- **Present tense** — topic strings read as "on X": `note:open`,
  `theme:change`, `plugin:toggle`.
- **Payload shape is documented in topics.js** — no schema library;
  the constant comment block is the spec.
- **Publish at the module-level choke point** (state-transition
  function), not the DOM handler — so every code path fires the
  event regardless of how the action was triggered (click, keyboard,
  URL fragment, API result).
- **One publish per fact** — if three code paths enter edit mode,
  they all funnel through `setEditMode()`, which publishes once.

## Topic registry

| # | Topic | Payload | Published from |
|---|---|---|---|
| 1 | `note:open` | `{ path }` | `router.js` afterEach |
| 2 | `note:create` | `{ path }` | `Note.vue` saveNew / saveNote |
| 3 | `note:save` | `{ path }` | `Note.vue` saveExisting / saveNote (content-only) |
| 4 | `note:rename` | `{ oldPath, newPath }` | `Note.vue` saveExisting / saveNote (path changed) |
| 5 | `note:delete` | `{ path }` | `Note.vue` deleteConfirmedHandler |
| 6 | `note:refs-rewritten` | `{ oldPath, newPath }` | `SearchResults.vue` fixAllRefs / fixSingleRef |
| 7 | `file:upload` | `{ name }` | `Note.vue` postAttachment (success) |
| 8 | `sidepanel:open` | `{}` | `SidebarPanel.vue` openSidebar |
| 9 | `sidepanel:close` | `{}` | `SidebarPanel.vue` toggleSidebar |
| 10 | `sidepanel:section-show` | `{ section }` | `SidebarPanel.vue` toggleRecent (show) |
| 11 | `sidepanel:section-hide` | `{ section }` | `SidebarPanel.vue` toggleRecent (hide) |
| 12 | `search-menu:open` | `{}` | `SearchResults.vue` sort-menu show |
| 13 | `search-menu:close` | `{}` | `SearchResults.vue` sort-menu hide |
| 14 | `modal:open` | `{ name }` | `Modal.vue` visibility watch |
| 15 | `modal:close` | `{ name }` | `Modal.vue` visibility watch |
| 16 | `theme:change` | `{ id, resolvedId, mode }` | `themes.js` applyTheme |
| 17 | `plugin:toggle` | `{ id, enabled }` | `pluginSettings.js` legacy preference publisher |
| 18 | `plugin:auto-enable` | `{ enabled }` | `pluginSettings.js` legacy preference publisher |
| 19 | `settings:line-numbers` | `{ value }` | `pluginSettings.js` saveViewLineNumbers |
| 20 | `debug:change` | `{ enabled }` | `debug.js` toggleDebug |
| 21 | `search:perform` | `{ term }` | `router.js` afterEach |
| 22 | `search:change` | `{ term }` | `SearchInput.vue` searchTerm watch |
| 23 | `search:include-nested` | `{ value }` | `SearchResults.vue` toggleNested |
| 24 | `editor:mode-change` | `{ mode }` | `Note.vue` setEditorMode |
| 25 | `note:edit-start` | `{ path }` | `Note.vue` setEditMode |
| 26 | `note:edit-end` | `{ path }` | `Note.vue` exitEditState |
| 27 | `app:open-settings` | `{ page? }` | gear / palette / keybindings / plugin SDK → the one openSettings handler |

## Built-in consumers

| Consumer | Subscribes to | Action |
|---|---|---|
| `noteIndex.js` | `note:create`, `note:rename`, `note:delete` | Calls `refreshNoteIndex()` — keeps the sidebar filter and wiki-link resolver fresh without a page reload. |
| `ServerViewer.vue` | `plugin:toggle`, `plugin:auto-enable` | Re-renders the open note so plugin enable/disable changes take effect immediately. |

## Subscribing from a component

```js
import { subscribe, TOPICS } from "../bus/index.js";

// In <script setup> or module scope:
subscribe(TOPICS.NOTE_OPEN, ({ path }) => {
  console.log("opened:", title);
});
```

Subscriptions set up at module scope fire once on import; subscriptions
in `<script setup>` fire when the component mounts. Choose the scope
that matches the consumer's lifetime.

Managed browser plugin subscriptions also belong to their exact activation.
Retirement releases that activation's listeners and fences queued delivery before
invocation; a late retired activation cannot dispose its replacement's listeners.
An already-running arbitrary trusted-browser handler is not forcibly cancelled.

Server plugin lifecycle facts/sync are a separate host-dispatched channel. Managed
note/file operations submit one nonblocking sync from their actual reconciled
effects, projected through each consumer's read grants; they do not depend on a
browser publishing a bus topic. Partial effects are accounted for, no-effect or
private-data writes produce no sync, and scans deduplicate already-acknowledged
managed changes. See [plugin-api.md](plugin-api.md) and [saving.md](saving.md).

## Publishing a new fact

```js
import { publish, TOPICS } from "../bus/index.js";

// After the state transition:
publish(TOPICS.NOTE_CREATE, { path: "dad/recipes/stew" });
```

To add a new topic, extend both `client/bus/topics.js` (constant +
payload doc) and this document — the topic file is the run-time
contract; this file is the human-readable index.
