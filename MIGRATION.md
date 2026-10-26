# Migrating from globnotes v2 to v3

**Status:** draft. v3 is in development on `main` and has not been released. This
guide records what a v2 install must do to move to v3, as decided so far, and grows
as the v3 pieces are designed. Items marked **Open** are not decided yet.

## Staying on v2

v3 is a major release with breaking changes. Nobody has to upgrade: v2 keeps
working, and its fixes ship as v2.x releases. To stay on v2, pin the image tag `2`
(or `2.5`, `2.5.0`) instead of `latest`.

**Open:** whether `latest` moves to v3 at release. If it does, installs that pull
`latest` would upgrade by surprise, so the v3 release notes and the README must say
so plainly.

## What changes, in one table

| # | Area | v2 | v3 |
|---|---|---|---|
| 1 | Vaults | One notes tree per instance, mounted at `/data` | Several vaults per instance. `/data` (configurable) is the **base folder**, and each vault is a folder in it, e.g. `/data/notes/`. Vaults can also live elsewhere, declared by environment variable or config file |
| 2 | Addresses | Notes at `/<path>` | Each vault has its own path under the instance address, e.g. `notes.home/dad/…` |
| 3 | Logins | One login for the whole instance (`none`, `read_only`, `password`, `totp`), stored in `<state>/config.json` | **Accounts** belong to the instance; each person has one. Each account chooses a password or password + TOTP. Each vault grants **Admin / Edit / View / None** per account, plus an "Everybody else" level (guest, i.e. not signed in) |
| 4 | v2 login modes | `none` / `read_only` / `password` / `totp` | Per vault: "Everybody else: Edit" = old `none`; "Everybody else: View" = old `read_only`; "Everybody else: No access" plus named accounts = old `password` / `totp` |
| 5 | App state per vault | `<notes>/.globnotes/`, or `GLOBNOTES_INDEX_PATH` | `<vault folder>/.globnotes/`, or under `GLOBNOTES_METADATA_PATH`: `<metadata>/<vault>/` |
| 6 | Instance state (accounts, vault list) | — | `/data/.globnotes/`, or with `GLOBNOTES_METADATA_PATH`: `<metadata>/_/` (e.g. `/etc/globnotes/_/accounts`) |
| 7 | Configuration | Environment variables only | Layered: built-in defaults → optional TOML config file → environment variables. Unknown `GLOBNOTES_*` variables stop the server at boot with a list of problems |
| 8 | Environment variable names | `GLOBNOTES_PATH`, `GLOBNOTES_AUTH_TYPE`, … | New names, no aliases (see "Environment variables" below) |
| 9 | Plugins | Installed per instance; enabled and configured for the one vault | Still installed once per instance. Each vault turns them on and off and has its own plugin settings, approvals and data |

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
5. **Start v3 and sign in.** **Open:** whether the v2 login carries over (see
   below). Without an import, first start runs setup: create your account. Then use
   "New vault" with your folder's name, e.g. `notes`. globnotes asks whether to
   adopt the existing folder, and you become its admin.
6. **Set the vault's access:** add accounts for other people, and choose
   "Everybody else" (see row 4 of the table to match your v2 login mode).
7. **Check plugins and settings** for the vault. **Open:** which v2 vault settings
   (branding, quick access, plugin enablement and settings, backups) carry over
   automatically when a folder with a v2 `.globnotes` is adopted.

## Environment variables

**Open:** the final v3 names come from the layered-configuration design. An
earlier v3 prototype used the pattern below. It is a starting point, not a
decision:

| # | v2 | Earlier prototype (reference) |
|---|---|---|
| 1 | `GLOBNOTES_HOST` / `GLOBNOTES_PORT` | `GLOBNOTES__SERVER_HOST` / `GLOBNOTES__SERVER_PORT` |
| 2 | `GLOBNOTES_PATH_PREFIX` | `GLOBNOTES__SERVER_PATHPREFIX` |
| 3 | `GLOBNOTES_PATH` | base folder `GLOBNOTES__VAULTS_BASEPATH`; a vault elsewhere `GLOBNOTES_<VAULT>_PATH` |
| 4 | `GLOBNOTES_INDEX_PATH` | `GLOBNOTES_METADATA_PATH` (decided for v3; the prototype used `GLOBNOTES__METADATA_BASEPATH`) |
| 5 | `GLOBNOTES_AUTH_TYPE`, `_USERNAME`, `_PASSWORD`, `_SECRET_KEY`, `_TOTP_KEY`, `_SESSION_EXPIRY_DAYS` | Replaced by instance accounts and per-vault access. **Open:** how an operator declares accounts or a vault's admin in config (decided: a vault declared in config names its admin in the same config; without one, the vault has no admin) |
| 6 | `GLOBNOTES_READ_ONLY_SETTINGS` | **Open** (per-vault access levels may replace it) |
| 7 | `GLOBNOTES_BRAND_*`, `GLOBNOTES_QUICK_ACCESS_*` | Per vault, e.g. `GLOBNOTES_<VAULT>_BRAND_NAME` |
| 8 | `GLOBNOTES_AUTO_ENABLE_PLUGINS` | Per vault, e.g. `GLOBNOTES_<VAULT>_PLUGINS_AUTOENABLE` |
| 9 | `GLOBNOTES_INDEX_BATCH_SIZE`, `_INDEX_BATCH_DELAY`, `_SCAN_CACHE_TTL`, `_RENDER_WORKERS` | `GLOBNOTES__INDEX_BATCHSIZE`, `__INDEX_BATCHDELAY`, `__INDEX_SCANCACHETTL`, `__PLUGINS_RENDERWORKERS` |
| 10 | `GLOBNOTES_PLUGIN_SETTINGS` | **Open** |
| 11 | `PUID` / `PGID` | Unchanged |

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
| 1 | Does the v2 login carry over? (One-time import of `config.json` into the first account and vault admin, or sign up again) |
| 2 | Which v2 vault settings carry over when a v2 folder is adopted |
| 3 | Final environment variable names |
| 4 | Whether `latest` moves to v3 |
| 5 | Unraid template: new or updated |
| 6 | Mapping of `GLOBNOTES_READ_ONLY_SETTINGS` and `GLOBNOTES_PLUGIN_SETTINGS` |
