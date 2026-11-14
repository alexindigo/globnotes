# Layered configuration

Server, launcher and healthcheck use this strict boundary. These are v3 names;
do not apply them to a released v2 installation. No old-name aliases exist.

The shipped, commented `defaults/globnotes.toml` is complete. An optional partial
`config/globnotes.toml` overrides individual leaves, then environment variables
override those leaves. `GLOBNOTES_CONFIG` selects another operator file. Defaults
and the conventional overlay are relative to the application root, not the
working directory. Mount only `config/`, never over `defaults/`.

Instance variables have an empty vault namespace: `GLOBNOTES__SERVER_PORT` sets
`server.port`; `GLOBNOTES__METADATA_PATH` sets `metadata.path` by the same rule.
`GLOBNOTES_REVISION` remains a build input, not an operator TOML setting.

Unknown keys/variables, wrong types, invalid ranges and missing shipped leaves
are collected as one error. An env override cannot repair an incomplete defaults
file. Only an absent conventional overlay is optional; an explicitly selected
missing/unreadable file is an error. Diagnostics identify keys and sources, never
setting values. Integers must be safe whole numbers; durations are finite seconds;
booleans accept only `true`/`false`. Empty strings and empty lists are real choices.
The defaults file documents each leaf's units and environment spelling.

## Vault scopes and declarations

`defaults/vault.toml` is a separate complete baseline. A vault reads partial saved
`<vault metadata>/config.toml`, then its env leaves. `my_notes` becomes `MY__NOTES`:
every underscore in the name doubles. For example,
`GLOBNOTES_MY__NOTES_QUICKACCESS_LIMIT=8`. Names match `[a-z][a-z0-9_]*`; only `_`
is reserved for instance state. Schema section names such as `metadata` and
`brand` remain valid vault names: `GLOBNOTES_METADATA_PATH` declares the notes
path of a vault named `metadata`, never the instance metadata path. It is not an
alias for `GLOBNOTES__METADATA_PATH`. The current single-vault runtime rejects
unsupported declarations instead of treating old instance spellings as aliases.

Declare an external path and optional admin login together:

```toml
[vaults.entries.family]
path = "/srv/family"
admin = "alex"
```

The env equivalents are `GLOBNOTES_FAMILY_PATH` and `GLOBNOTES_FAMILY_ADMIN`.
Declarations merge by name and leaf. An omitted/empty admin is valid and grants
no configured administrator; this loader does not create accounts or grants.
The shipped `vaults.entrydefaults` is a template, not an operator setting.

Without relocation, instance data is `<base>/.globnotes/` and each vault's data
is `<notes>/.globnotes/`. With `GLOBNOTES__METADATA_PATH=/etc/globnotes`, instance
data is `/etc/globnotes/_/` and vault data `/etc/globnotes/<name>/`. There is no
per-vault `_INDEX` alias. The loader calculates paths and validates all supplied
scopes, never discovers folders, creates vaults or moves state. The future registry
supplies persisted scopes alongside declarations; declaring one external vault
does not erase saved vaults. Unavailable paths are not silently created.

Plugin deployment settings remain addressed JSON under `plugins.settings`, not
arbitrary TOML plugin tables. Installed plugin schemas still own address/field
validation before workers start. Credentials and ACLs are not vault TOML leaves.

## Persistence boundary

`BoundFileStore` provides checked replacement for both JSON callers and the
vault TOML owner. File/directory symlinks retain their identities.
Writes check target access, preserve ownership/mode and sync a sibling temporary
file. Bound-file identity and bytes are rechecked immediately before an atomic
rename; a detected change causes a conflict. The check and rename are separate
operations: a concurrent external edit in that short window can still be
overwritten. Owners serialize their own writes; only the owner parses policy
and publishes updated state at successful replacement. Cleanup failures remain
errors, including after replacement has already committed.

## Plugin deployment pins

Plugin composition is manifest/default baseline, saved plugin owner, explicit
vault TOML pin, then env pin. Shipped `autoenable = true` is not a pin: saved
`plugins.json` policy wins unless an operator states the leaf. Explicit `false`
is a pin too. Per-plugin choices, settings, revisions and approvals retain their
existing owners; effective pins are never copied into those files.

```toml
[plugins]
autoenable = false
settings = '{"backups":{"preferences":{"location":"/backups"}}}'
```

For vault `family`, `GLOBNOTES_FAMILY_PLUGINS_SETTINGS` replaces that addressed
JSON leaf (including an explicit `{}`). Installed manifests validate plugin,
page, field and value before any Worker starts, even for inactive plugins.
Settings provenance distinguishes `toml` from `environment` and marks only pinned
fields read-only. Existing plugin full-page saves may include unchanged pinned
fields; altered pins reject without changing the stored fallback. TOML/env use
the same canonical value fingerprints and source-key/approval lifecycle.

## Service inputs

Public config and branding snapshots expose per-leaf origin classes and pin
flags, never deployment paths, raw files or addressed plugin values. Explicit
unsupported `vault` targets reject rather than selecting another vault. Branding
pins disable only the named field; siblings and images retain their normal
workflow. Reset omits pinned leaves and explains what it can clear. The resolved
facade keeps authentication separate.

Index pacing, directory-cache TTL and hub scan interval are configured in seconds;
the configuration boundary converts them once to milliseconds for their consumers.
Session days become JWT expiry seconds at that boundary. Render workers remain per
vault, so total worker count grows with vault count. Services receive snapshots,
not live environment lookups. Runtime images include the shipped defaults.

`VaultConfigStore` saves partial vault TOML through this boundary.
App writes preserve omitted leaves and explicit empty values, and cannot replace
env-pinned leaves (even with the same value). External edits take effect on restart.
An external change detected by the final identity/bytes check is a conflict, not
an implicit reload. A concurrent external edit between that check and the atomic
rename can still be overwritten, as described above.
Invalid TOML is retained. Plugin policy/settings writes still go to their existing
owners, not to a second app-saved TOML copy. Branding images remain in `brand/`.

## Current single-vault startup

This phase serves only the vault named `globnotes`, declared with
`GLOBNOTES_GLOBNOTES_PATH` or `[vaults.entries.globnotes]`, otherwise at
`<vaults.basepath>/globnotes` (default `/data/globnotes`). The notes folder must
already exist. Other names or multiple declarations require the future registry
piece and fail explicitly; they are not silently reduced to the first vault.

Version, all configuration scopes and installed plugin pins validate before
metadata parents are prepared by the bound-file owner and services start.
The launcher uses that same owner, never recursively chowns mounted notes, and
retains PUID/PGID/non-root handling. Health uses the same nonsecret shell projection
for address, port, prefix and allowed Host header. It does not write configuration
or export resolved values as environment overrides.

Startup never converts `config.json` to TOML, relocates metadata, deletes old index
files or logs relocation commands. Operator relocation is separate from the future
v2 import tool. Setup/access still use the guarded private JSON record as a local
transition bridge; this is not the final v3 import format or an Admin/ACL system.
Auth mode, credentials, signing keys and read-only-settings environment inputs are
retired without replacements. Use setup/access for those existing workflows.
`LOGLEVEL` is ignored; use `GLOBNOTES__LOG_LEVEL`. See [MIGRATION](../MIGRATION.md)
for the full old-to-new inventory.
