# <img src="client/assets/brand/logo.svg" width="300px" alt="globnotes" />

A self-hosted, database-less note-taking web app where **a note's title is its path** — built for Obsidian vaults and nested markdown trees.

globnotes is a fork of [flatnotes](https://github.com/dullage/flatnotes) by Adam Dullage. flatnotes deliberately keeps every note in one flat directory; globnotes keeps everything else about its spirit (zero-config, single container, distraction-free) and changes one thing: notes can live in subdirectories, and a note's title *is* its relative path.

```
data/
├── dad/
│   ├── recipes/
│   │   └── soup.md        →  note at /dad/recipes/soup
│   └── assets/
│       └── broth.jpg      →  served at /dad/assets/broth.jpg
└── ideas.md               →  note at /ideas
```

## Why

Markdown is supposed to be app-independent. If your notes already live in folders — an Obsidian vault, a git repo, a Syncthing share — globnotes gives you a clean web view (and editor) over exactly that structure, without flattening anything. Mount whatever you like as subdirectories:

```yaml
volumes:
  - /srv/dad-notes:/data/dad
  - /srv/mom-notes:/data/mom
```

Folders are never "managed": creating `a/b/c` makes the directories, renaming `a/b` → `x/y` moves the file, and empty directories are pruned away (git-style).

## Features

- **Real-path notes** — the URL path IS the vault path: `/dad/recipes/soup` is the note, `/dad/assets/broth.jpg` is its image. Relative links (`![](broth.jpg)`, `[x](../other.md)`) work exactly like in Obsidian — no rewriting, no magic.
- **Obsidian-flavored rendering** — `[[wiki-links]]` (with `|alias` and `#heading`), `![[image embeds]]`, `==highlights==`, `> [!callouts]`, `%%comments%%`, YAML frontmatter, mermaid diagrams, KaTeX math.
- **Sidebar folder tree** — Obsidian-style nested tree with expand/collapse, active-note highlight, filter textbox, and hover shortcuts to folder views.
- **16 themes** — light, dark, system auto-detect, Catppuccin, Dracula, Gruvbox, Nord, Solarized, Tokyo Night, and more. Pick one in the menu, preview it behind the panel, no page reload.
- **Full-text search and `#tags`** across the whole tree, scoped to a folder or recursive, with real-time filtering.
- **New-note flow** — `Untitled N` prefills in the current folder context; dead wiki-links offer a one-click "Create note" affordance.
- **Attachment-aware renames** — moving a note across folders prompts you to move its referenced files along too, or just fix the links.
- **First-run setup wizard** — no auth env vars? globnotes asks on first launch: set a password or explicitly disable auth. Each choice is deliberate.
- **Agent-friendly** — raw markdown and files over plain HTTP (see below).

## Getting started

```bash
docker run -d \
  --name globnotes \
  -p 8080:8080 \
  -v /path/to/your/notes:/data \
  alexindigo/globnotes:latest
```

Open `http://localhost:8080` and complete the first-run setup: create a password, choose read-only (browse and search, no editing), or disable auth entirely (trusted networks only).

Or with docker compose:

```yaml
services:
  globnotes:
    image: alexindigo/globnotes:latest
    container_name: globnotes
    restart: unless-stopped
    ports:
      - "8080:8080"
    volumes:
      - ./notes:/data
      # Optional: mount additional sources as subdirectories
      # - /srv/dad-notes:/data/dad
      # - /srv/mom-notes:/data/mom
    environment:
      # Optional. Leave unset for the first-run setup wizard.
      # GLOBNOTES_AUTH_TYPE: "none"  # trusted home network only!
```

The image is published to both [Docker Hub](https://hub.docker.com/r/alexindigo/globnotes) (`alexindigo/globnotes`) and [GHCR](https://github.com/alexindigo/globnotes/pkgs/container/globnotes) (`ghcr.io/alexindigo/globnotes`) — same tags (`latest`, `1.0`, `1.0.1`, …), same content; use whichever registry you prefer.

## URL model

| What | URL |
|---|---|
| Notes | `/dad/recipes/soup` — the whole root space |
| Vault files | `/dad/assets/broth.jpg` — same tree |
| App pages | `/_/login`, `/_/new`, `/_/search` |
| API, health, swagger | `/_/api/*` |
| Built assets | `/_/assets/*` |

The only reserved top-level segment is `_` — don't name a vault folder that. Everything else is yours.

`GLOBNOTES_PATH_PREFIX` is respected for multi-instance deployments (e.g. one instance at `/dad/` and another at `/mom/` behind one host) — note pages, files, API and assets all live under the prefix, and relative links keep working.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `GLOBNOTES_PATH` | `/data` (in container) | Root directory of the notes tree. **Required** outside docker. |
| `PUID` / `PGID` | `1000` / `1000` | User the app runs as (container). Set to your host user's ids (`id -u` / `id -g`) so note edits can write. **globnotes never `chown`s your vault** — it only creates/owns the `.globnotes` index dir. |
| `GLOBNOTES_INDEX_BATCH_SIZE` | `200` | Notes indexed per commit batch during the initial background sync. Lower it on very constrained hosts. |
| `GLOBNOTES_INDEX_BATCH_DELAY` | `0.1` | Seconds to sleep between index batches (CPU throttle). `0` disables. |
| `GLOBNOTES_AUTH_TYPE` | *(unset → first-run wizard)* | `none`, `read_only`, `password` or `totp`. Env always wins over the wizard's stored choice. |
| `GLOBNOTES_USERNAME` / `GLOBNOTES_PASSWORD` | — | Login credentials (for `password`/`totp`). If unset, taken from the wizard's stored config. |
| `GLOBNOTES_SECRET_KEY` | — | JWT signing key. If unset, taken from the wizard's stored config. |
| `GLOBNOTES_TOTP_KEY` | — | TOTP secret (for `totp`). |
| `GLOBNOTES_SESSION_EXPIRY_DAYS` | `30` | Login session length. |
| `GLOBNOTES_HOST` / `GLOBNOTES_PORT` | `0.0.0.0` / `8080` | Listen address (container). |
| `GLOBNOTES_PATH_PREFIX` | — | Serve under a sub-path, e.g. `/mom` (multi-instance reverse proxies). |
| `GLOBNOTES_QUICK_ACCESS_*` | — | `HIDE`, `TITLE`, `TERM`, `SORT`, `LIMIT` for the home page quick-access section. |

### Home network deployment

`GLOBNOTES_AUTH_TYPE=none` turns globnotes into a home-wide knowledge source: anyone (and any *agent*) on the network can read and write. `read_only` is the middle ground — open browsing, no writes ("family wiki; editing happens in Obsidian"). Either way, everything in the tree becomes reachable, so keep it to networks you trust. A warning is logged at startup when auth is off.

## Agent access

With token auth (or no auth at all), your notes are plain HTTP:

```bash
# Raw markdown
curl -H "Authorization: Bearer $TOKEN" https://notes.example/_/api/files/dad/recipes/soup.md

# Search (add folder=dad/recipes to scope to a subtree, nested=false for root-only)
curl -H "Authorization: Bearer $TOKEN" "https://notes.example/_/api/search?term=soup"

# Drop a file into a vault
curl -H "Authorization: Bearer $TOKEN" \
  -F "file=@photo.jpg" -F "directory=dad/recipes" \
  https://notes.example/_/api/files
```

## Migrating from flatnotes

- Rename `FLATNOTES_*` env vars to `GLOBNOTES_*` (same names otherwise).
- Your `/data` works as-is: flat notes keep their titles, and the index is rebuilt automatically (`.globnotes` replaces `.flatnotes`; both are hidden and safe to delete).
- The special `attachments/` directory is gone as a concept — existing `attachments/x.jpg` links keep working (it's now just a directory, served like any other). New uploads land beside the note being edited.

## Deferred / future work

See [FutureDevelopment.md](FutureDevelopment.md) — note transclusion, unresolved-link styling, backlinks/graph, editor-side Obsidian features, and more.

## Development

```bash
# Python backend & tests
.venv/bin/python -m pip install -r requirements-dev.txt  # includes pytest, fonttools
.venv/bin/python -m pytest tests/ -q

# Client build & tests
npm ci
npm run build
npx vitest run

# Client dev server
npm run dev
```

## Credit

globnotes is a fork of [flatnotes](https://github.com/dullage/flatnotes) by Adam Dullage, who built the excellent foundation this project stands on. GNU Lesser General Public License v3.0 licensed (see [LICENSE](LICENSE)); upstream flatnotes code remains under the MIT License (see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)). Full attribution for upstream, dependencies, and the community that shaped the design lives in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
