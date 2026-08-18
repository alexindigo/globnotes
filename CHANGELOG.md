# Changelog

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
