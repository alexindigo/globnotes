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

`RETAINED_TOPICS` in `topics.js` declares state topics; currently only
`note:edit-state` is retained. Publishing replaces that topic's current value.
A new subscriber receives the current value once on a **microtask** after
subscription, if one exists. Unsubscribing cancels that queued delivery. A newer
live publication supersedes the queued snapshot, so subscribers never receive
old state after new state. Live delivery uses the same publication-identity fence:
if a subscriber synchronously publishes newer state, remaining listeners skip the
superseded outer publication. Event topics retain mitt's synchronous delivery,
including reentrant delivery; `note:edit-start`,
`note:edit-end` and `note:save`, are never retained or replayed.

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
| 2 | `note:create` | `{ path }` | `noteSaveOwner.js` acknowledge (new identity) |
| 3 | `note:save` | `{ path }` | `noteSaveOwner.js` acknowledge (content-only) |
| 4 | `note:rename` | `{ oldPath, newPath }` | `noteSaveOwner.js` acknowledge (path changed) |
| 5 | `note:delete` | `{ path }` | `noteController.js` deleteConfirmedHandler |
| 6 | `note:refs-rewritten` | `{ oldPath, newPath }` | `searchResults.js` rewriteFile (acknowledged single/bulk rewrite) |
| 7 | `file:upload` | `{ name }` | `noteAttachments.js` postAttachment (success) |
| 8 | `sidepanel:open` | `{}` | Not currently published (opening only persists the preference) |
| 9 | `sidepanel:close` | `{}` | `sidebarPreferences.js` setSidebarVisible (close) |
| 10 | `sidepanel:section-show` | `{ section }` | `sidebarPreferences.js` setSidebarRecent (show) |
| 11 | `sidepanel:section-hide` | `{ section }` | `sidebarPreferences.js` setSidebarRecent (hide) |
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
| 22 | `search:change` | `{ term }` | `tagCompletion.js` searchTermChanged (SearchInput / SwitcherInput term watches; typing, tag insertion, clear and prop updates) |
| 23 | `search:include-nested` | `{ value }` | `searchPreferences.js` setIncludeNested |
| 24 | `editor:mode-change` | `{ mode }` | `noteController.js` setEditorMode |
| 25 | `note:edit-start` | `{ path }` | `noteController.js` setEditMode |
| 26 | `note:edit-end` | `{ path }` | `noteController.js` exitEditState |
| 27 | `app:open-settings` | `{ page? }` | gear / palette / keybindings / plugin SDK → the one openSettings handler |
| 28 | `note:title-changed` | `{ title }` | `noteController.js` publishTitle (live buffer or loaded note) |
| 29 | `note:edit-state` (retained) | `{ path, revision, editing, unsaved, canSave }` | `noteController.js` refreshDirtyState |
| 30 | `vault:change` | `{ seq, path, kind, oldPath?, hash?, peer }` (paths include extensions) | `vaultChanges.js` accepted stream/poll entry |
| 31 | `vault:reset` | `{ next }` — re-read consumer snapshots after a history gap | `vaultChanges.js` accepted reset |
| 32 | `vault:conflicts` | `{ revision }` - re-read vault-scoped conflict metadata, including reconnect snapshots | `vaultChanges.js` accepted SSE/poll metadata event |
| 33 | `vault:drivers` | `{ revision }` - re-read vault-scoped sync instance state, including reconnect snapshots | `vaultChanges.js` accepted SSE/poll metadata event |

`vault:conflicts` carries no paths, count or content. Its revision is independent
of file sequence and cannot advance or suppress a `vault:change`. It is an
invalidation, not retained state or permission: inbox consumers read the filtered
list/count, and comparison consumers review current versions. The existing
connection owns both event domains; reconnects publish a fresh metadata snapshot.

`vault:drivers` uses that same connection and lifetime. It contains only a revision,
never keys, settings, paths or attention items. Driver, conflict and file cursors
are independent. Consecutive successful polls deduplicate each metadata domain;
a reconnect or page resume invalidates each again, even at an equal or lower
revision. `driverSettingsController.js` coalesces invalidations into current API
reads and retains local work across them. No key value is ever put on the bus.

`note:edit-state` never carries note text. `path` is the current requested path;
`revision` increases per content edit. The controller publishes whenever revision,
unsaved state or save capability changes (also when the requested path changes).
`editing` is true while a note is in edit mode. Late subscribers can initialize
their session from the retained state, without depending on having observed
`note:edit-start`. `unsaved` means the buffer differs from the latest submitted snapshot or the FIFO
has unresolved work, excluding unapplied filename text. `canSave` is false outside
edit mode, for an invalid current name or while the queue is paused. Exiting edit
mode, or disposing its controller while editing, publishes
`editing: false, unsaved: false, canSave: false`, retiring the retained session.

## Built-in consumers

| Consumer | Subscribes to | Action |
|---|---|---|
| `noteIndex.js` | `note:create`, `note:rename`, `note:delete` | Calls `refreshNoteIndex()` — keeps the sidebar filter and wiki-link resolver fresh without a page reload. |
| `sidebarTree.js` | `note:create`, `note:rename`, `note:delete` | Invalidates the lazy cache, reloads root and expanded levels, and refreshes Recent when enabled. Releases subscriptions and retires pending reads on dispose. Sidepanel visibility/section facts remain published by `sidebarPreferences.js`. |
| `noteIndex.js`, `quickAccess.js`, `sidebarTree.js`, `searchResults.js` | `vault:change` for Markdown members and `vault:reset`, through `vaultNoteInvalidation.js` | Refreshes live note-list projections for every peer, not only browser-authored writes. Synchronous group facts coalesce into one snapshot invalidation; mounted consumers release it on dispose. App's existing shared connection supplies transport. |
| `serverViewer.js` | `plugin:toggle`, `plugin:auto-enable`, `theme:change` | Re-renders the open note for plugin switches and the current Mermaid palette; releases subscriptions on dispose. |
| `noteController.js` | `editor:save`, `editor:save-close`, `editor:exit-edit`, `editor:toggle-edit`, `editor:toggle-source-mode` | Owns note actions for the mounted view; registers at mount and unsubscribes on dispose. |
| `noteController.js` | `vault:change`, `vault:reset` | Refreshes clean snapshots or retains dirty/deleted state. Current state is projected into the fixed-footprint header status; one-time update, merge and recreation messages use its existing toast helper. |
| `MarkdownEditor.vue` | Formatting/structure and `editor:find` topics in `sourceEditorActions.js`; `keybindings:change` | Applies source edits or opens find; reconfigures the layer keymap. Mount/unmount owns subscriptions; action availability is checked before execution. |
| `WysiwygEditorInner.vue` / `WysiwygEditor.vue` | Command topics / link-popover topic in `wysiwygEditorActions.js` | Inner editor calls the mapped Milkdown command; wrapper opens its toolbar link popover. Mount/unmount owns subscriptions; action availability is checked before execution. |

Note notifications do not add or republish domain facts. External observations
arrive through the vault topics above; acknowledged saves still publish once
from `noteSaveOwner.js`. The controller chooses state text and toast messages;
the view only renders its snapshot.

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
