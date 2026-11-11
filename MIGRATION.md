# Migrating from globnotes v2 to v3

**Status:** draft. v3 is in development on `main` and has not been released. This
guide records what a v2 install must do to move to v3, as decided so far, and grows
as the v3 pieces are designed. Items marked **Open** are not decided yet.

## Staying on v2

v3 is a major release with breaking changes. Nobody has to upgrade: v2 keeps
working, and its fixes ship as v2.x releases from the `v2` branch. When v3 is
released, the Docker tag `latest` moves to v3, so **pin a v2 tag** (`v2`, `2`,
`2.5`, `2.5.0`) to stay on v2. `v2` and `2` follow v2 maintenance releases;
those releases cannot move `latest` back from v3.

## What changes, in one table

| # | Area | v2 | v3 |
|---|---|---|---|
| 1 | Vaults | One notes tree per instance, mounted at `/data` | Several vaults per instance. `/data` (configurable) is the **base folder**, and each vault is a folder in it, e.g. `/data/notes/`. Vaults can also live elsewhere, declared by environment variable or config file |
| 2 | Addresses | Notes at `/<path>` | If the only vault is named `globnotes`, v2 note URLs stay at `/<note path>`, with no picker. Otherwise, notes are at `/<vault>/<note path>` |
| 3 | Logins | One login for the whole instance (`none`, `read_only`, `password`, `totp`), stored in `<state>/config.json` | **Accounts** belong to the instance; each person has one. Each account chooses a password or password + TOTP. Each vault grants **Admin / Edit / View / None** per account, plus an "Everybody else" level (guest, i.e. not signed in) |
| 4 | v2 login modes | `none` / `read_only` / `password` / `totp` | Per vault: "Everybody else: Edit" = old `none`; "Everybody else: View" = old `read_only`; "Everybody else: No access" plus named accounts = old `password` / `totp` |
| 5 | App state per vault | `<notes>/.globnotes/`, or `GLOBNOTES_INDEX_PATH` | `<vault folder>/.globnotes/`, or under `GLOBNOTES_METADATA_PATH`: `<metadata>/<vault>/` |
| 6 | Instance state (accounts, vault list) | - | With `GLOBNOTES_METADATA_PATH`: `<metadata>/_/` (e.g. `/etc/globnotes/_/accounts`). Without it: `<base>/.globnotes/` (default `/data/.globnotes/`) |
| 7 | Configuration | Environment variables only | Layered: built-in defaults → optional TOML config file → environment variables. Unknown `GLOBNOTES_*` variables stop the server at boot with a list of problems |
| 8 | Environment variable names | `GLOBNOTES_PATH`, `GLOBNOTES_AUTH_TYPE`, … | New names, no aliases (see "Environment variables" below) |
| 9 | Plugins | Installed per instance; enabled and configured for the one vault | Still installed once per instance. Each vault turns them on and off and has its own plugin settings, approvals and data |
| 10 | Flatnotes compatibility | Flatnotes migration instructions and a Legacy Flatnotes keymap | Compatibility is dropped: no `FLATNOTES_*` names or Legacy Flatnotes keymap. Obsidian is the default keymap and the base for Custom; a saved Legacy choice falls back to Obsidian |
| 11 | Concurrent editor saves | A save replaces current file contents | Editor saves merge independent line edits; overlapping edits create a neighboring conflict copy and move the editing session to it, preserving newer typing and queued saves |
| 12 | Plugin writes | `save`, `rename`, `delete`, `file-write` replace or remove unconditionally; render code may write granted paths directly | Plugin contract 2: every plugin write states its base (the version or text it read); a stale one merges, is kept as a conflict copy or is refused. Render Workers cannot write files. See "For plugin authors" below |

### Safe saves and live updates

The editor sends its base text with each update. The server uses it once for
three-way merging, then forgets it; the hub retains metadata only. Conflict
copies use `<stem>.conflict-YYYYMMDD-HHMMSS-globnotes.md` (UTC, numbered on
collision) in the original folder. The original is not replaced on conflict.
A banner on the copy links back to the original through normal navigation.
Conflict records are stored in metadata-only schema 3; versions 1 and 2 migrate
automatically in place without changing note content or filenames. No operator
reset, content backfill or conflict-file import is needed.

The **Conflicts** navigation badge and the editor banner's **Review conflict**
open the inbox/comparison. Explicit choices keep Original, replace it with Copy,
keep both, save a manual merge, or postpone. Keep both leaves the existing copy
filename as an ordinary file. Destructive choices check both reviewed versions
and name the removed file before confirmation. Browser merge drafts are retained
separately from hub metadata and need Resume plus a fresh review after recovery.
Deleting either member outside the app closes the record; recognized renames
update its paths. An outside closure never silently discards an open merge draft.
See [Saving notes](docs/saving.md#resolving-a-conflict) for exact effects and
unknown-outcome/departure protection.

### Search index deletion privacy

Index format 11 rebuilds an older search index once from the live vault folder,
into a fresh SQLite file. This removes deleted names and content retained by old
index files. The complete new index replaces the old one atomically; a failed
or interrupted rebuild retains a usable canonical index for retry. Search uses
the existing initial-index behavior during the rebuild. Fresh installs create
the new format directly, without a migration rebuild.

The index uses FTS5/core secure deletion and checked WAL truncation after erasing
transactions. It is derived data with NORMAL WAL durability: recent index
transactions may be lost on a crash or power failure, then recovered from the
folder on restart. A lost index deletion is re-applied and erased during that
reconciliation. The hub keeps its existing durability and anonymous tombstones.
See [hub retention](docs/hub.md#retention-and-consumers).

### Sync driver metadata and keys (M5)

Hub schema versions 1 through 3 upgrade additively to schema 4 in place, preserving
notes and existing conflict records. No operator action, content backfill or
reset is required. New sync instances start off and are configured in Settings ->
Sync. Driver API 1 is separate from plugin contract 2; the storage SDK and author
guide are in [docs/drivers.md](docs/drivers.md). M5 ships no real endpoint plugin.

Driver keys live in `driver-secrets.sqlite` (mode 0600, secure delete, DELETE
journaling) beside the existing server keys in the configured state directory.
They are write-only in the UI/API, scoped to an instance, and removed when that
instance is removed. When state is inside the vault, the Sync page explains that
outside tools copying the whole folder copy keys too. Keep state outside those
copies with `GLOBNOTES_METADATA_PATH`. Key entry works over ordinary
local-domain HTTP; deployments outside a trusted LAN can protect the link with
a TLS reverse proxy such as Caddy or Nginx Proxy Manager.

Open notes receive outside-change notifications over ordinary HTTP. Viewing and
clean editing refresh in place; dirty editing keeps its buffer. An outside
deletion is shown, and explicitly saving the retained editor text recreates the
note. Outside renames are currently treated as deletion rather than followed.
Every writer now states its base (docs/hub.md "Bases"). REST `PATCH` (content or
rename) needs `base` or `baseContent` and `DELETE` needs `?base_version=`; without
one the response is `428` with code `base_required` and nothing is written. MCP
`globnotes_update_note` (also a rename) and `globnotes_delete_note` need
`expected_last_modified` or `expected_hash`; without one the tool returns an error
result (`isError: true`) whose text says which arguments to pass, and nothing is
written. Scripts read the note
first and pass its `version`. This is not a real-time co-editing protocol or
external filesystem CAS. See
[Saving notes](docs/saving.md) for the complete FIFO and departure behavior.

### For plugin authors

The plugin contract version is 2 (`contractVersion` in the catalog and the
Worker snapshot). A v2-era plugin that writes must change:

1. Read before writing: `ctx.readNote(path)` and `ctx.files.read(path)` return
   `version`.
2. Pass `base` with every `save`, `rename`, `delete`, `file-write` and
   `ctx.files.requestWrite(path, bytes, {base})`: `{kind:"version", version}`,
   `{kind:"text", content}` for notes (merges), or `{kind:"absent"}` to create.
   Without it the request fails with `base_required` and the plugin shows a
   `plugin_contract_2` diagnostic.
3. Choose `onStale`: `"copy"` (default, keeps your bytes as a conflict copy next
   to the original) or `"refuse"` (`base_stale`, nothing written). Stale renames
   and deletes are always refused.
4. Move direct `Deno.writeFile` calls in render code to a server runtime using
   actions; render Workers have no write permission.

Reading, rendering, hooks, settings, private data, endpoints and `ctx.fs` are
unchanged. Details: [plugin-api.md](docs/plugin-api.md) "Writes state their base"
and "Contract version".

## Steps (as decided so far)

1. **Back up** your notes folder and its `.globnotes` folder (or your
   `GLOBNOTES_INDEX_PATH` folder).
2. **Mount your existing notes as a vault folder** inside the base folder, instead of
   as the base itself:
   - v2: `-v /path/to/notes:/data`
   - v3: `-v /path/to/notes:/data/notes` (any vault name)
   No migration code moves files.
3. **Replace the environment variables** with their v3 names (table below). Remove
   any you don't need; v3 refuses to start on unknown `GLOBNOTES_*` names.
4. **If you kept app state outside your notes** (`GLOBNOTES_INDEX_PATH`), move it
   to the v3 layout yourself: `<metadata>/<vault>/` under `GLOBNOTES_METADATA_PATH`.
   v3 doesn't detect or move old state. Relocating state is the operator's choice
   and responsibility.
5. **Import your v2 data with the migration tool.** Upgrading doesn't reset
   anything: your login (username, password, TOTP), if any, branding, quick access,
   plugin choices and settings, plugin data and backups carry over to v3. A one-time
   migration tool (name and exact arguments to be decided, e.g.
   `globnotes import-v2 <v2 folder> <vault>`) **copies** the v2 data into v3:
   - for `password` / `totp` installs, the v2 login becomes your account and the
     admin of that vault;
   - `none` / `read_only` installs have no login to import. **Open:** how the first
     account and vault admin are created; setup could create the first account
     and the tool could make it admin of the imported vault;
   - v2 settings, plugin data and backups go to their v3 places.
   It never changes or moves the v2 files, says what it did, and running it again
   doesn't import twice. The same tool also **restores a v2 backup into v3**: point
   it at a copied v2 notes folder (with its `.globnotes`, or the separate
   `GLOBNOTES_INDEX_PATH` folder).
6. **Set the vault's access:** add accounts for other people, and choose
   "Everybody else" (see row 4 of the table to match your v2 login mode).
7. **Check plugins and settings** for the vault. They should match what you had
   in v2.
8. **Check your keyboard shortcuts** in Settings → Keybindings. The Legacy
   Flatnotes keymap is gone; a saved Legacy choice now uses Obsidian. Save with
   Ctrl/Cmd+S (Ctrl/Cmd+Enter remains an alias), toggle edit with Ctrl/Cmd+E,
   and open the quick switcher with Ctrl/Cmd+O. Custom starts from Obsidian and
   keeps your saved overrides. Flatnotes migration instructions and
   `FLATNOTES_*` environment variable names are no longer supported.

## Environment variables

The layered-configuration startup now uses these names without aliases.
`N` is the upper-case vault name with every underscore doubled (`my_notes` ->
`MY__NOTES`). The current runtime serves only `globnotes`; identity and registry
work and the explicit v2 import tool remain separate future pieces. Do not point
this intermediate stack at a v2 install expecting an automatic conversion.

| # | v2 | v3 |
|---|---|---|
| 1 | `GLOBNOTES_HOST` / `GLOBNOTES_PORT` | `GLOBNOTES__SERVER_HOST` / `GLOBNOTES__SERVER_PORT` |
| 2 | `GLOBNOTES_PATH_PREFIX` | `GLOBNOTES__SERVER_PATHPREFIX` |
| 3 | `GLOBNOTES_PATH` | base folder `GLOBNOTES__VAULTS_BASEPATH`; a vault elsewhere `GLOBNOTES_<VAULT>_PATH` |
| 4 | `GLOBNOTES_INDEX_PATH` | `GLOBNOTES_METADATA_PATH` selects a base: vault state `<base>/<name>/`, instance state `<base>/_/`. No prototype metadata aliases or per-vault `_INDEX` |
| 5 | `GLOBNOTES_AUTH_TYPE`, `GLOBNOTES_USERNAME`, `GLOBNOTES_PASSWORD`, `GLOBNOTES_SECRET_KEY`, `GLOBNOTES_TOTP_KEY` | Removed, no env replacements. The current local bridge retains guarded setup/access records; future instance accounts and vault ACLs own the final model |
| 6 | `GLOBNOTES_READ_ONLY_SETTINGS` | Removed. The current saved access lock remains until the identity piece supplies Admin capabilities |
| 7 | `GLOBNOTES_BRAND_*`, `GLOBNOTES_QUICK_ACCESS_*` | `GLOBNOTES_N_BRAND_NAME`, `_BRAND_ACCENT`, `_QUICKACCESS_HIDE`, `_TITLE`, `_TERM`, `_SORT`, `_LIMIT` |
| 8 | `GLOBNOTES_AUTO_ENABLE_PLUGINS` | Per vault, e.g. `GLOBNOTES_<VAULT>_PLUGINS_AUTOENABLE` |
| 9 | `GLOBNOTES_INDEX_BATCH_SIZE`, `_INDEX_BATCH_DELAY`, `_SCAN_CACHE_TTL`, `_RENDER_WORKERS` | `GLOBNOTES__INDEX_BATCHSIZE`, `__INDEX_BATCHDELAY`, `__INDEX_SCANCACHETTL`, `__PLUGINS_RENDERWORKERS` |
| 10 | `GLOBNOTES_PLUGIN_SETTINGS` | `GLOBNOTES_N_PLUGINS_SETTINGS`, retained addressed JSON, not TOML plugin tables |
| 11 | `PUID` / `PGID` | Unchanged |
| 12 | `GLOBNOTES_SESSION_EXPIRY_DAYS` | `GLOBNOTES__SESSIONS_EXPIRYDAYS` |
| 13 | `GLOBNOTES_MCP_ENABLED` / `GLOBNOTES_MCP_RATE_LIMIT` | `GLOBNOTES__MCP_ENABLED` / `GLOBNOTES__MCP_RATELIMIT` |
| 14 | `GLOBNOTES_ALLOWED_HOSTS` | `GLOBNOTES__SERVER_ALLOWEDHOSTS` (comma-separated env, TOML string list) |
| 15 | `GLOBNOTES_HUB_SCAN_INTERVAL` | `GLOBNOTES__HUB_SCANINTERVAL`, seconds |
| 16 | `LOGLEVEL` | Ignored; use `GLOBNOTES__LOG_LEVEL` |

The default base is `/data`, not the notes root. For this intermediate single-vault
runtime mount existing notes at `/data/globnotes`, or explicitly declare
`GLOBNOTES_GLOBNOTES_PATH`. A differently named or multi-vault runtime awaits the
registry piece. Startup neither creates/adopts notes nor moves state, converts
JSON or removes legacy Whoosh files. Optional TOML and every new env leaf are
documented in [configuration](docs/configuration.md) and the shipped defaults.

## Unraid

The Community Applications template (`alexindigo/unraid-templates`) needs a v3
version:
- the notes path becomes a vault folder under `/data`;
- "App data" maps to `GLOBNOTES_METADATA_PATH`;
- the new variable names.

**Open:** a separate v3 template, or the same template with a version note.

## Open items (collected)

| # | Item |
|---|---|
| 1 | Migration tool details (decided: a one-time tool that copies v2 data into v3 and also restores v2 backups; nothing is reset): its name, arguments and exact steps |
| 2 | The exact list of v2 settings and data that carry over, and where each lands in v3 |
| 3 | Identity and multi-vault registry implementation |
| 4 | Unraid template: new or updated |
| 5 | Final identity/ACL replacement of the transitional saved access lock |
| 6 | **Open:** how the first account and vault admin are created for v2 `none` / `read_only` installs, which have no login to import |
| 7 | Instance-state default is settled: `<base>/.globnotes/` without `GLOBNOTES_METADATA_PATH` |
