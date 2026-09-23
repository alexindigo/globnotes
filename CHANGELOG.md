# Changelog

## v2.1.1 (2026-09-22)

The first-run experience is rebuilt: a redesigned setup wizard with
access-mode management, an empty-vault home greeting that shows the vault
path, and one shared CTA component behind every call to action. Deployments
gain `GLOBNOTES_INDEX_PATH` — the state dir (config, index, plugins) can now
live apart from the vault — and container ownership that follows the vault
owner via PUID/PGID. The editor gains an in-editor find panel on Ctrl+F,
in-page anchors stop hijacking note history, and long lines wrap in both
view and preview. Rounding it out, a visual polish pass unifies link
contracts, tag colors, block padding, and code block chrome.

### 2026-09-22

#### Feature

First-run and deployment work lands together: the setup wizard is redesigned
around explicit access-mode management with setup/login observability, an
empty vault now greets from the home page with the vault path, and all CTAs
share the single CtaButton component. On the deployment side,
`GLOBNOTES_INDEX_PATH` relocates the state dir away from the vault, and the
editor gains an in-editor find panel bound to Ctrl+F in source mode.

- feat: setup and login observability (`b211619`)
- feat: first-run wizard redesign and access-mode management (`5c3fa5c`)
- feat: CtaButton — the single shared CTA component (`15b848d`)
- feat: empty-vault home greeting with the vault path (`a280610`)
- feat: GLOBNOTES_INDEX_PATH — the state dir can live apart from the vault (`6313cb4`)
- feat: Ctrl+F opens an in-editor find panel in source mode (`e1f6efc`)

#### Fix

A quirks pass from dogfooding the new flows: the auth token cookie reads
the path prefix from the meta tag so login works behind a prefixed proxy,
the sidebar tree live-refreshes on note changes, quick-switcher recents
prune on delete and follow renames, container ownership follows the vault
owner (PUID/PGID), in-page anchors no longer hijack note history, and view
and preview both wrap long lines.

- fix: token cookie reads the path prefix from the meta tag (`49b5525`)
- fix: sidebar tree live-refreshes on note changes (`4c17f10`)
- fix: quick-switcher recents prune on delete and follow renames (`9d5466b`)
- fix: container ownership follows the vault owner (PUID/PGID) (`cb86bae`)
- fix: in-page anchors no longer hijack note history (`f66d397`)
- fix: view and preview wrap long lines (`67141d8`)

### 2026-09-20

#### Fix

The note page settles into one content-flow rhythm: block padding across
elements derives from a single shared scale, the padding around the note
header rule is corrected, and code blocks get proper chrome — padding, the
copy button moved to the top, and an icon on the Edit toggle.

- fix: one content-flow rhythm + shared block-padding scale (`7ece4b7`)
- fix: padding around the note header rule (`5468c31`)
- fix: code block chrome — padding, copy at top; Edit toggle icon (`9c37aea`)

### 2026-09-19

#### Fix

In-body links now share a single rest/hover contract instead of per-context
styling.

- fix: in-body links share rest/hover contract (`7a54b15`)

### 2026-09-18

#### Fix

Tag links pick up the theme brand color, and the tag underline, code color,
and Edit hover states are aligned with it.

- fix: tag links use theme brand color (`c2bb062`)
- fix: tag underline, code color, Edit hover (`3dcc0bd`)

## v2.1.0 (2026-09-17)

The app shell gets its structural rework: the shell owns the viewport, one
centered page column carries the header and the content, the sidebar lives
below the header band, and the corner buttons (sidebar toggle, menu) are
fixed chrome whose non-overlap with the column is guaranteed by the column's
width rule — not by hand-kept padding. The sidebar can now pin as a docked,
in-flow panel that the column yields to. On top of the shell: a command
palette, a preview tab for the rendered unsaved buffer, shareable line
highlights in view mode, a confirmed branding reset, a hover contrast
restyle, theme-following mermaid diagrams, and dimmed unresolved wikilinks.
The repo also gains a resource-capped deno devcontainer serving a review
instance on :8002.

### 2026-09-16

#### Feature

Development gains a proper devcontainer: deno 2.9.6 (the same version the
production image builds with), hard cgroup caps (8g memory, 256 pids,
4 cpus), the test vault bind-mounted, and the review server published
on :8002.

- feat: deno devcontainer — runArgs-capped, review server on :8002 (`6748ef6`)

### 2026-09-11

#### Feature

The command palette lands — app commands flow through the action channel
into a palette panel — and resetting the branding now asks before wiping
it, with tests covering the confirmation flow.

- feat: command palette — commands through the action channel (`9c46a90`)
- feat: branding reset asks before wiping (`b55a8ed`)

#### Fix

Hover polish round two restores background hovers and fixes the
CustomButton variant prop. The app-shell rework makes the shell own the
viewport: the header lives inside the centered page column, the sidebar
exists only below the header band (its border can no longer cross the
header), pinned mode docks the sidebar at the screen's left edge with the
column yielding then shrinking, and the overlay scrim dims header and
body uniformly.

- fix: hover round 2 — restore bg hovers, fix CustomButton variant prop (`2c5a012`)
- fix: app shell layout — shell owns the viewport, header is one band (`15460a3`)

### 2026-09-10

#### Feature

The sidebar can pin as a docked in-flow panel. Notes gain a preview tab
rendering the unsaved buffer (via a server-side render endpoint), and view
mode gets shareable rendered-line highlights. Hover styling shifts to the
brand color for contrast across buttons and panels, mermaid diagrams follow
every theme's palette, and unresolved wikilinks render dimmed,
Obsidian-style, via the autolinks plugin.

- feat: sidebar pin — docked in-flow mode (`eafa83f`)
- feat: preview tab — the rendered unsaved buffer (`38d9e97`)
- feat: view-mode line links — shareable rendered-line highlights (`68cf7b6`)
- feat: hover restyle — brand color shift for contrast (AX) (`a11cae4`)
- feat: mermaid diagrams follow every theme's palette (`a9fced7`)
- feat: unresolved wikilinks — class + dimmed style (`da6bf26`)

#### Fix

Dist stamping becomes idempotent (a fresh build no longer double-stamps),
the plugins doc's rpc drift is corrected, and test-vault cleanup is tidied
with new boot helpers.

- fix: dist stamp idempotency, docs rpc drift, test-vault cleanup (`5c024e2`)

## v2.0.0 (2026-09-07)

The server is rewritten in Deno — the Python original is gone — and
routing now runs on the published [@pathfinder/pathfinder](https://jsr.io/@pathfinder/pathfinder)
framework. The user-facing contract is unchanged: same environment
variables, same vault format, same ports, same `/data` volume. **v1 users
can pull the new image directly and keep their `/data` as-is.** On top of
the rewrite, this release lands white-label branding, keybinding layers,
a dual-mode plugin contract with the Properties panel, a reworked quick
switcher, Tabler icons, and a wave of search/sidebar/render polish.

### 2026-09-06

#### Feature

The dual-mode plugin batch ships its pilot: the Properties panel renders
frontmatter as an interactive editor in WYSIWYG and as structured markup
in view mode, backed by a plugin contract that lets any plugin ship both
a server half and an editor half. File-format integrity lives in core, so
disabling the plugin degrades to a safe framed view — frontmatter can no
longer be corrupted by the WYSIWYG editor at all.

- feat: globnotes-properties plugin — interactive Properties panel (`bf01264`)
- docs: dual-mode plugin contract (`bd27c8e`)

### 2026-09-05

#### Refactor

Routing moved from the in-house matcher to the published
`@pathfinder/pathfinder` framework — 656 lines of router, loader, and
fixture code deleted, with the route table now expressed as plain
filesystem convention (`#param` segments, method files).

- refactor: migrate routing to @pathfinder/pathfinder (`dd39eb0`)

#### Fix

Two WYSIWYG fixes: the toolbar's icon binding was a static string, so
every icon button rendered empty and only the H1/H2/H3 labels showed; and
saving from WYSIWYG corrupted frontmatter (`---` turned into `***`, YAML
became a setext heading, brackets got escaped). The toolbar renders its
icons again, and frontmatter is parsed, displayed, and re-serialized
verbatim — a core frontmatter node owns the file format, independent of
any plugin toggle.

- fix: WYSIWYG toolbar icon binding (`aa6dfc7`)
- fix: frontmatter survives WYSIWYG (`ec62c7b`)

#### Feature

The dual-mode plugin contract: a plugin can ship a `client.js` editor
half alongside its server half. `/api/plugins` flags dual-mode plugins, a
fresh-from-disk endpoint serves the client module, and the editor loads
enabled modules with bare imports resolved through a build-injected
import map plus a `plugin-sdk` chunk (the browser-native equivalent of
Grafana's AMD registry). A shared YAML subset backs the frontmatter node
and the panel.

- feat: dual-mode plugin wiring — client module contract (`8da048a`)

### 2026-09-04

#### Feature

The switcher rows got their final shape: the note path under the title,
the matched letters highlighted inline, and the search row sticky at the
top of the list.

- feat: switcher rows — path under title, inline match highlights, sticky search row (`157ec47`)

### 2026-09-03

#### Feature

The switcher became a real launcher: rows show *what* matched (fuzzy
highlights), results support `Ctrl/Cmd+1-9` direct jumps and
`Ctrl+Enter` to open the full search, keys render platform-resolved
(`⌘` on macOS) in the cheat sheet and layer descriptions, and folder
names participate in matching.

- feat: platform-resolved keys in the keybindings cheat sheet (`e306278`)
- feat: platform-resolved Mod in layer descriptions (`711398c`)
- feat: quick switcher shows what matched (`5f4a000`)
- feat: switcher result shortcuts — Ctrl/Cmd+1-9 jump, Ctrl+Enter to search, row hints (`413d57b`)

#### Fix

Switcher matching and ranking tightened: folder names match, and
scattered subsequence matches now rank below contiguous ones via a
gap-penalized score.

- fix: quick switcher matches folder names (`e03a872`)
- fix: switcher ranking — gap-penalized scoring (`9f6e0e6`)

### 2026-09-02

#### Feature

Keybinding layers landed: layered key maps (with a Legacy layer) backed
by a store, an editor action channel on the event bus, a settings-menu
entry with picker and cheat-sheet panel, a rail rework for the panel, and
a restore/quick-switcher binding in the Legacy layer.

- feat: editor action channel on the bus (`face1ed`)
- feat: keybinding layers data + store (`4e21840`)
- feat: restore / quick-switcher binding in Legacy layer (`bc98d5f`)
- feat: keybindings menu item, picker, and cheat-sheet panel (`117419d`)
- feat: keybindings panel rail rework (`d6dce2d`)

#### Docs

The README documents the keybinding system.

- docs: keybindings section in README (`e7702ce`)

### 2026-09-01

#### Feature

White-label branding: configure the instance name, accent color, and
logo/icon (svg/png/jpg/webp/gif/ico uploads) from a settings dialog —
backed by brand config endpoints and a manifest slot; the navbar gains a
live All Notes count badge.

- feat: All Notes badge — live vault count in the navbar (`7d41549`)
- feat: brand config and endpoints — name, accent, logo/icon files, manifest (`349ecf3`)
- feat: branding dialog — name, logo, icon, accent in the settings menu (`38ae7e4`)
- feat: image uploads for branding logo/icon — svg, png, jpg, webp, gif, ico (`4d50c85`)

#### Refactor

`package.json` is gone — every npm dependency resolves via `deno.json`,
and prettier resolves through `deno.lock` for ad-hoc formatting.

- chore: drop package.json — all npm deps resolve via deno.json (`ab36820`)
- chore: resolve prettier in deno.lock for ad-hoc deno-run formatting (`c258fc1`)

#### Docs

The README documents the branding feature.

- docs: branding section in README (`42fe836`)

### 2026-08-31

#### Feature

The switcher panel was extracted into a shared component (one input +
harness reused by the unified search modal), the search box moved to a
center-anchored position shared by the Home hero and the modal (one
`--switcher-lift` constant), mermaid diagrams follow the app's light/dark
theme, and focusing Home's search box hands the caret straight into the
modal.

- feat: extract the switcher panel — shared input + harness for the unified search modal (`89f4c05`)
- feat: center-anchored searchbox — modal anchor prop, Home hero anchor, shared --switcher-lift (`24b3ab6`)
- feat: mermaid follows the app's light/dark mode (`0d12872`)
- feat: focus handoff — Home's search box opens the modal with the caret moving with it (`a3967bb`)

### 2026-08-30

#### Feature

The navbar was consolidated (search and All Notes as icon buttons, plugin
menu item gets the plug icon), Search and the quick switcher unified into
one modal, and the icon system switched from MDI to Tabler.

- feat: unify Search and quick switcher into one modal (`4f41614`)
- feat: search icon button in navbar, drop the hardcoded `/` shortcut (`c766b52`)
- feat: All Notes moves to the navbar as an icon button (`2253764`)
- feat: switch the icon system from MDI to Tabler (`511a5cd`)
- feat: plugins menu item uses the plug icon (`8f82c64`)

#### Fix

Modal dismissal and icon fallout from the consolidation: every modal
dismisses on Escape, navbar action icons share one standard icon set,
and the Toggle pill renders its full glyph after the Tabler swap.

- fix: dismiss every modal on Escape (`9f1f18e`)
- fix: navbar action icons share the standard @mdi/js icon set (`7c6af0f`)
- fix: Toggle icons render again after the Tabler swap (`04db5c6`)

#### Style

The new-note button uses a pencil-in-box icon with the label moved to a
tooltip.

- style: new-note button uses pencil-in-box icon, label moves to tooltip (`3701000`)

### 2026-08-29

#### Style

Sidebar sections get a uniform empty line above each for consistent
rhythm.

- style: uniform empty line above each sidebar section (`7c7eaa7`)

### 2026-08-28

#### Refactor

The note vocabulary was swapped everywhere: `path` is the path, `title`
is the display title — a prerequisite for the title-based switcher and
index work below.

- refactor: swap note vocabulary — path is the path, title is the display title (`ee2955a`)

#### Feature

The note index gained display titles and aliases, and the quick switcher
arrived: fuzzy-jump to any note by title, alias, or path.

- feat: enrich note-index with display title and aliases (`9a8db3b`)
- feat: quick switcher — fuzzy-jump to a note by title, alias, or path (`7192a80`)

### 2026-08-27

#### Feature

The event bus kept expanding its coverage: settings-menu and search-menu
open/close, file ops, search scope, ref-rewrite, line numbers, modal
lifecycle, debug toggle, and live-search facts are all published for
plugins and UI panels.

- feat: debug toggle surfaces bus events as toasts (`82fbcae`)
- feat: publish settings-menu and search-menu open/close events (`253eefc`)
- feat: publish file, search-scope, ref-rewrite, and line-number facts (`d6b31db`)
- feat: publish modal lifecycle, debug-toggle, and live-search facts (`77646c7`)

### 2026-08-26

#### Build

The client build and test suite now run under Deno — npm is dropped from
the build pipeline entirely (the package-lock.json deletion alone removes
9187 lines).

- build: run client build and tests under Deno, drop npm (`6a0403c`)

#### Refactor

SCSS overrides replaced with plain CSS; the sass-embedded dependency is
gone.

- refactor: replace SCSS overrides with plain CSS, drop sass-embedded (`e043e57`)

#### Feature

A client-side event bus arrived, and the note index stays fresh via
lifecycle events; search, editor-mode, and edit-session facts publish
onto it for downstream features.

- feat: client event bus; note index stays fresh via lifecycle events (`a1b524a`)
- feat: publish search, editor-mode, and edit-session facts on the bus (`521c270`)

#### Fix

The open note re-renders when plugin settings change; a prefer-const
cleanup in the search titles parser.

- fix: re-render open note when plugin settings change (`23ed046`)
- fix: prefer-const in search titles parser (`1ec6914`)

#### Docs

README gained an Obsidian-flavored support section and an app
screenshot; the event bus is documented and the Development section
corrected.

- docs: add Obsidian-flavored support section to README (`9788b89`)
- docs: add app screenshot to README (`067b515`)
- docs: document event bus and fix Development section (`e3ac724`)
## v1.2.0 (2026-08-21)

### 2026-08-20

#### Feature

Renaming a note now updates links across the vault — wikilinks and
markdown links — and the work is client-driven by design: after a rename
the client finds referencing notes via search, rewrites their links
client-side (`client/links.js`), and resaves them. The server stays a
pure file mechanism with no cross-note side effects. A rename is now a
tor-reliable flow, and the e2e suite runs on a zero-dependency CDP
driver instead of the playwright npm package.

- feat: wikilinks between notes update on rename (`5ec91c9`)
- feat: markdown links update on rename; e2e suite ported to zero-dep CDP (`b2f96a9`)
- refactor: client drives link updates on rename (`3a86782`)

#### Fix

The open editor syncs its content after rename saves — the client
updates your open text when the links get rewritten (no need to reload
to see the new links).

- fix: editor shows server-rewritten content after rename saves (`46fe47a`)

#### Test

- test: run.sh orchestrates the CDP suite with a fresh browser per harness (`b690a99`)
- test: tour-chain fails fast on incomplete fixtures (`af7ab51`)

### 2026-08-19

#### Feature

- feat: copy button on code blocks (`638acf5`)
- feat: wikilinks between notes update on rename (`5ec91c9`)

#### Test

- test: all three rename strategies verified end-to-end (`9328d32`)
- test: editor-modes harness + self-contained code-tokens fixture (`1290c30`)
- test: tour-chain harness + self-restoring rename harness (`3b16232`)

#### Chore

- chore: gitignore .dsh_config (`6771c06`)

### 2026-08-18

#### Fix

The rename flow became honest: the dialog reliably appears (the preview
endpoint was shadowed by the greedy note route), and moving a note
preserves attachment subpaths. Highlights and callouts render again
(they were silently broken in the renderer plumbing). Inline code now
follows the theme instead of toastui's hardcoded dark mauve.

- fix: rename dialog actually appears; attachment moves preserve subpaths (`9cfd185`)
- fix: highlights and callouts render again (`33c9f15`)
- fix: inline code text color follows the theme (`2ae7f21`)
- style: inline code uses the theme's brand color (`a704165`)
- style: darker brand in globnotes light theme (`229e129`)
- test: real-flow rename harness (`339854e`)

## v1.1.2 (2026-08-18)

### 2026-08-18

#### Fix

Theme surface colors never actually applied: `style.css` duplicated all
surface vars (background, text, border, code tokens) as static
`body`/`body.dark` selector defaults, and a body's own declaration beats
the `<html>` inline theme vars — so every dark theme rendered like
globnotes-dark and every light theme like globnotes-light, with only
brand (and, post v1.1.1, code tokens) honoring the chosen theme. The
duplicates are gone; `initTheme` moved to `index.js` (entry top) so the
inline vars land before mount. Dracula renders its true
#282a36/#f8f8f2, Latte its #eff1f5/#4c4f69.

- fix: theme surface colors actually apply (`987e6dc`)

## v1.1.1 (2026-08-17)

### 2026-08-17

#### Fix

Code syntax highlighting was silently broken since the mermaid feature
landed: nothing imported `prismjs`, so the code-syntax-highlight
plugin's global was empty, and our `customHTMLRenderer` (mermaid
support) shadowed the plugin's code-block renderer anyway. Code blocks
rendered as plain text in every theme — "color schemes don't work at
all." `prism-global.js` now sets `window.Prism` before the plugin
bundle evaluates (so its grammars register), and the viewer runs
`Prism.highlightAllUnder` after mount, independent of the renderer
chain. Verified headlessly: `.token` spans render and follow the active
theme; mermaid diagrams still render.

- fix: code syntax highlighting (broken since the mermaid feature) (`f74f92e`)

## v1.1.0 (2026-08-17)

### 2026-08-17

#### Fix

Two lazy-tree UX corrections on today's v1.0.6 launch. Folders now show
the expand chevron simply because they are folders — "expandable" is
part of being a folder, not a property of its contents — and the
`hasChildren` hint is gone from the tree endpoint (also faster: no
per-child scandir). Persisted expanded folders hydrate their children
on sidebar open — previously a restored-expansion folder showed empty
children until toggled.

- fix: lazy tree UX — always-expandable folders, hydrated restored expansion (`103ac93`)

## v1.0.6 (2026-08-17)

### 2026-08-17

#### Feature

The sidebar no longer needs the full recursive vault scan up front — a
real cost on large vaults (a ~10s glob on a 17k-file NAS tree). A new
`GET /_/api/tree` endpoint lists one directory level at a time (folders
carry a `hasChildren` chevron hint), and the sidebar fetches lazily:
root on open, a folder's children when expanded — the user's current
folder is always front of the line. Filter mode keeps the existing
full-list behavior. The recursive scan itself is now cached briefly
(`GLOBNOTES_SCAN_CACHE_TTL`, default 15s) with invalidation on our own
writes. The batched initial sync also indexes breadth-first so
top-level search becomes useful early.

- feat: lazy sidebar tree via per-level tree endpoint + scan cache (`3f42ec1`)

#### Fix

A sync crash exposed by the scan cache: the "add new" phase could try
to re-index a file that the prune phase had just detected as externally
deleted, because the cached scan still listed it. Both sync paths now
carry the deletion set forward and tolerate mid-sync deletions.

- fix: sync tolerates files deleted mid-sync / present in stale scan cache (`3f42ec1`)

## v1.0.5 (2026-08-17)

### 2026-08-17

#### Fix

The sidebar could stay permanently empty: the note index was fetched
exactly once at app mount, and a single failed fetch (a race with a
still-warming server, or a dropped request on a slow vault) cached an
empty list forever. `refreshNoteIndex` now retries with backoff and
keeps previously loaded titles on final failure; opening the sidebar
with an empty list re-fetches; and the sync banner refreshes the list
when a background sync completes.

- fix: sidebar no longer stays empty when the note-index fetch fails (`40481c3`)

## v1.0.4 (2026-08-17)

### 2026-08-17

#### Feature

Startup no longer blocks on a full index sync — the failure mode behind
"server not up for a long time" on large vaults (100%+ CPU, 300MB+ RAM
on a Synology-sized tree). The initial sync now runs in a background
daemon thread, committing in batches with a delay between them
(`GLOBNOTES_INDEX_BATCH_SIZE` 200, `GLOBNOTES_INDEX_BATCH_DELAY` 0.1s)
to bound CPU and memory, and releases the sync lock between batches so
user work preempts it. Saves reindex their note immediately — create,
update, and delete are "front of the queue" instead of waiting for the
next sync. Search and tags return partial results instantly while the
initial sync runs instead of blocking. A new `GET /_/api/index-status`
endpoint reports progress, and the UI shows a small "Indexing notes…"
banner while the sync runs. The startup index optimize is dropped
entirely. Verified on a 3000-note vault: health in ~3s (was: the full
sync duration), search 208ms during sync, save 33ms with the note
immediately searchable, ~0.4% CPU sampled, 61MB RAM.

- feat: background index sync in batches, priority reindex on save (`416dffd`)

## v1.0.3 (2026-08-16)

### 2026-08-16

#### Breaking

The container entrypoint no longer `chown -R`s the vault on startup.
Upstream flatnotes force-chowned everything under `/data` to the app
user on every boot — convenient for writes, but it recursively rewrote
ownership of the user's own tree (slow on large vaults, harmful on
NAS/NFS/ACL shares, and able to break other apps' access to the same
files). globnotes now creates and owns only the `.globnotes`
index/config directory; mounted content keeps its ownership forever.
**If your vault is owned by a different user than the app, note writes
will now fail with a permission error instead of the tree being silently
chowned** — set `PUID`/`PGID` to the vault owner's ids (`id -u` /
`id -g` on the host). Also fixes a latent bug where the entrypoint used
`GLOBNOTES_PATH` without a default.

- fix: entrypoint no longer chowns the vault, only the index dir (`b479fdb`)

## v1.0.2 (2026-08-16)

### 2026-08-16

#### Feature

The container image is now published to Docker Hub
(`alexindigo/globnotes`) alongside GHCR from the same tag-triggered
workflow — one build, both registries, identical tags and content. The
README getting-started examples use the Docker Hub image and document
both registries.

- feat: publish the container image to Docker Hub alongside GHCR (`5286be8`)

## v1.0.1 (2026-08-15)

### 2026-08-15

#### Fix

The outlined brand SVGs shipped in v1.0.0 contained invalid path data
(`d="MM…"` — a duplicated moveto command from the outline generator's
contour splitter), which broke the logo render on the GitHub README and
any strict SVG pipeline. The splitter is removed (multi-contour glyph
output is valid as a single `d` attribute), all three SVGs and the favicon
rasters were regenerated, and the renders are now pixel-content verified.

- fix: valid path data in outlined brand SVGs (`9bf13df`)

## v1.0.0 (2026-08-15)

The first globnotes release. globnotes is a hard fork of
[flatnotes](https://github.com/dullage/flatnotes) that keeps its spirit —
database-less, single-container, distraction-free — and changes the storage
model: **a note's title is its path**, so notes live in nested directories
like an Obsidian vault. Everything below is the delta from upstream v5.5.4.

### 2026-08-13

#### Feature

The note-creation flow was audited end-to-end and its loose ends tied up.
New notes prefill as `Untitled N` in the current folder context and are only
written on save (no stray files from misclicks). Dead wiki-links no longer
dead-end: the 404 page offers a one-click "Create note" affordance. The
title editor splits into basename plus an editable folder field with a
native datalist of existing directories, and sidebar folder rows gained a
hover shortcut to their folder view. Cross-folder renames now detect
referenced attachments and offer move / relink / leave strategies, with a
post-move scan page to repair other notes' links. Brand assets were
finalized for publication: all SVGs converted to self-contained glyph paths
(zero font dependency), favicons regenerated, PWA manifest added, README
polished.

- feat: new notes prefill as Untitled N in the current folder context (`5de2e82`)
- feat: create missing notes from dead wikilinks (`ad66286`)
- feat: editable folder field with datalist and sidebar go-to (`6651d24`)
- feat: attachment-aware note moves (server-side) (`62fe605`)
- feat: attachment-aware rename dialog (client-side) (`8f91c2f`)
- feat: post-move scan page with per-file Fix and Fix-all (`30ac1e6`)
- feat: outlined brand assets, regenerated favicons, polished README (`9ce1964`)

#### Fix

Two title-handling correctness gaps closed. Titles starting with the
reserved `_` segment — which would shadow the app's `/_/` URL namespace and
be unreachable — are now rejected. The client mirrors the server's full
path-validation rules and shows the specific reason (empty segments,
dot-segments, forbidden characters, length) instead of a generic error.

- fix: reject '_' as first title segment (reserved URL namespace) (`aade9a2`)
- fix: client title validation mirrors server rules with specific messages (`9eb0594`)

#### Chore

- chore: consolidate logo assets, drop stale docs/ dupes (`2dc85c3`)

### 2026-08-12

#### Feature

Search grew into a folder-aware browser: a `folder` param scopes results to
a subtree with segment-aware prefix matching, an include-nested toggle
switches between recursive and current-level views, directory rows and a
`..` level-up row make folders traversable, and note paths render as
breadcrumbs linking to their folder views. The sidebar became an
Obsidian-style overlay drawer with a nested folder tree — expand/collapse,
active-note highlight, filter textbox, markdown icons, collapse-all with a
disabled state. Theming landed: 16 named color schemes with a menu picker
and a persistent preview panel that applies themes live behind it.
Supporting UI work: sticky navbar and note header, themed thin scrollbars
with stable gutters, floating corner buttons.

- feat: include-nested-folders toggle on the search page (`39ac50b`)
- feat: server-side nested filter for search (`0ad0707`)
- feat: folder param for search (segment-aware path prefix scoping) (`47f568b`)
- feat: wire the folder query param through the search page (`1360e55`)
- feat: subdirectory links for traversal when nested is off (`184e5a1`)
- feat: level-up link when traversing folders (`195f00c`)
- feat: strip the current folder prefix from result titles (`aec01a9`)
- feat: directories listed one per line like files, '..' row above them (`224aa37`)
- feat: note path is a breadcrumb - each section links to its folder view (`659b013`)
- feat: clear-to-list-all x button on the search bar (`25f94df`)
- feat: sidebar with obsidian-style folder tree (`67881bf`)
- feat: theme-styled thin scrollbars (`fcfa465`)
- feat: sticky top navbar (`d13451d`)
- feat: sticky note header (title, path, edit controls) above scrolling content (`1eeb893`)
- feat: sidebar is an overlay drawer on all viewports (`9822637`)
- feat: floating corner buttons - sidebar toggle top-left, menu top-right icon-only (`9a9b86f`)
- feat: collapse-all button dims when there is nothing to collapse (`9e39699`)
- feat: stable scrollbar gutters - content doesn't jump when a scrollbar appears (`732e294`)
- feat: filter textbox in the sidebar (`1818dc0`)
- feat: markdown icon on sidebar note rows (`54ed767`)
- feat: themable color schemes with a picker in the menu (`b31ff0d`)
- feat: theme selection via a persistent preview picker (`392013c`)

#### Fix

Interaction bugs from the same search/sidebar push: search refetches when
the folder param changes, folders with subdirectories no longer show a bare
"No Results" panel, the level-up row appears whenever inside a folder,
query params survive term changes, folder links respect the search term,
collapse toggles register while the tree is filtered, hover highlights only
apply to enabled buttons, and the navbar's alignment with the content
scroller was corrected through several iterations.

- fix: refetch search results when the folder param changes (`180b1de`)
- fix: no 'No Results' panel when the folder has subdirectories (`1b7018e`)
- fix: show the '..' level-up row whenever inside a folder (`60fa3c1`)
- fix: search keeps query params on term change; default title sort for '*' (`d5db287`)
- fix: filter folder links by the search term (`fda5298`)
- fix: allowlist THIRD-PARTY-NOTICES.md in .dockerignore (`d11d6bc`)
- fix: main content gets the same scrollbar breathing room as the sidebar (`054b340`)
- fix: note header lives outside the scrollable content area (`7da211f`)
- fix: sidebar affordances - proper collapse-all icon, toggle floats in the page corner (`236db1c`)
- fix: hover highlight only applies to enabled buttons (`28c6372`)
- fix: sidebar header label reads Files (`b797b4d`)
- fix: navbar aligns with content width; corner-button clearance only on small screens (`b2d6e84`)
- fix: navbar shares the content scroller box so edges align structurally (`e0b0b10`)
- fix: navbar beside the content scroller in a shared column (`628241b`)
- fix: sidebar header - dock icon closes from the left, filter right of collapse-all (`9f8d1e0`)
- fix: sidebar toggle icon position matches the corner button; filter box gets a reset x (`831f4bb`)
- fix: folder collapse toggles register while the tree is filtered (`9923b87`)

#### Docs

- docs: drop the syncthing/git thanks entry from third-party notices (`7ad717e`)

#### Chore

- chore: untrack .globnotes index dir (tracked before the gitignore) (`5d9669c`)

### 2026-08-11

#### Breaking

The fork itself: flatnotes became globnotes. Environment variables renamed
`FLATNOTES_*` → `GLOBNOTES_*`, the data dir `.flatnotes` → `.globnotes`,
and the storage model changed — a note's title is its relative path, so
`dad/recipes/soup` is a real note at `dad/recipes/soup.md` with directories
created on demand and pruned git-style. URLs were redesigned around real
paths: notes and vault files live in the root space (`/dad/recipes/soup`,
`/dad/assets/broth.jpg`) while app machinery moved under the `/_/`
namespace (`/_/api/*`, `/_/login`, `/_/new`, `/_/search`, `/_/assets/*`).
The only reserved top-level segment is `_`.

- chore: fork and rename to globnotes (`34c2a57`)
- feat: title-as-path note semantics (`eddc545`)
- refactor: move api and app pages under /_/ prefix (`f60a812`)
- feat: root-level note urls with native relative links (`9477855`)

#### Feature

Core platform features on the new model: vault-fidelity file serving and
uploads (files land beside the note being edited), a note-index endpoint
powering wiki-link resolution, an Obsidian-flavored viewer (wiki-links with
aliases and headings, image embeds, highlights, callouts, comments,
frontmatter, mermaid, KaTeX), a first-run auth setup wizard (password /
read-only / none — an explicit, stored choice), the sky-blue brand theme
with the Dancing Script `**` logo, split note titles (muted path + basename
with middle-ellipsis), and search-page layout refinements.

- feat: vault-fidelity file serving and uploads (`3a6ba05`)
- feat: /api/note-index endpoint (`5ad8f59`)
- feat: obsidian-flavored viewer (`2003058`)
- feat: first-run auth setup wizard (`0af20d1`)
- feat: globnotes branding — sky-blue theme, Dancing Script glob-asterisk logo (`f3c09d5`)
- feat: read-only mode in the first-run setup wizard (`452245f`)
- feat: split note title display into muted path prefix and basename (`5ab7797`)
- feat: move the muted path prefix below the title (`a06001e`)
- feat: add pt-8 spacing above the note path line (`be3e57d`)
- feat: buttons rest on the separator; middle-ellipsis for long paths (`6ec8dd8`)
- feat: keep at least two segments on each side of the path ellipsis (`95e35ce`)
- feat: quieter, left-aligned sort button on the search page (`dd2e77f`)
- feat: place the sort button above the search bar (`f7a71ff`)

#### Fix

Follow-ups from the URL redesign and header/search layout passes: the
health log filter matches the moved endpoint, note links generate real
slashes, remaining `api/` prefixes dropped from CRUD call paths, and a
series of spacing and alignment corrections.

- fix: health log filter matches the moved /_/api/health endpoint (`788a62d`)
- fix: generate note links with real slashes (`fdb1d99`)
- fix: drop remaining api/ prefixes in note CRUD call paths (`e9237b6`)
- fix: path line spacing pt-8 -> pt-2 (8px, not 8km) (`1bc6dda`)
- fix: tighten note header spacing (path 4px under title, hr closer) (`01164db`)
- fix: nudge note header separator down 4px (`103289e`)
- fix: let the search page use the full content width (`a65ecf8`)
- fix: quiet button style - neutral grey at 60% opacity (no blue cast) (`bac2d74`)
- fix: search page spacing and sort button color to match note path (`65f521a`)
- fix: bolder search page spacing (sort pull-up 12px, search gap 24px) (`bb756a9`)
- fix: sort button right-aligned above the search bar (`1800af3`)
- fix: search page spacing and quiet style that actually register (`8898d9f`)
- fix: search layout per review (`f2fdde8`)

#### Docs

- docs: seed FutureDevelopment.md with deferred items (`e96113a`)
- docs: readme, smoke checklist, compose example; ci: docker build and ghcr publish (`67c265c`)
- docs: add CREDITS.md with full attribution (`7ba9898`)
- docs: readme heading uses the svg logo (`34f80d2`)

#### Chore

- chore: globnotes entrypoint banner and regenerated uv.lock (`2bf37b6`)
- chore: gitignore the .globnotes index/config dir (`9d8043f`)

#### CI

- ci: add pytest workflow with smoke test (`5aa85ce`)

### 2026-08-02

#### Refactor

Build tooling modernized ahead of the fork: dependency management switched
to uv, Python and Node dependencies updated, build and runtime container
images bumped, devcontainer configuration removed.

- chore: Remove devcontainer configuration files (`91c71c7`)
- refactor: Switch to uv for dependency management (`790814c`)
- chore: Update python dependencies (`5d569a8`)
- chore: Update python version (`71decfd`)
- chore: Update build container image (`2fda847`)
- chore: Update runtime container image (`670768c`)
- chore: Update node dependencies (`1396cb7`)

#### Fix

- fix: Update Tailwind CSS configuration to exclude dist directory from content (`c44787e`)

### 2026-02-17

#### Docs

- docs: Update CONTRIBUTING.md (`0fdd0fd`)
