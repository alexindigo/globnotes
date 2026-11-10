# Layered configuration (v3 preparation)

The typed loader is preparatory: normal server startup still uses the existing
configuration until the coordinated v3 cutover. Do not apply these names to a
released v2 installation.

The shipped, commented `defaults/globnotes.toml` is complete. An optional partial
`config/globnotes.toml` overrides individual leaves, then environment variables
override those leaves. `GLOBNOTES_CONFIG` selects another operator file. Defaults
and the conventional overlay are relative to the application root, not the
working directory. Mount only `config/`, never over `defaults/`.

Instance variables have an empty vault namespace: `GLOBNOTES__SERVER_PORT` sets
`server.port`. `GLOBNOTES_METADATA_PATH` is the exact exception for `metadata.path`.
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
`GLOBNOTES_MY__NOTES_QUICKACCESS_LIMIT=8`. Names match `[a-z][a-z0-9_]*`; `_` is
reserved, but schema section names such as `brand` are valid vault names.

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
is `<notes>/.globnotes/`. With `GLOBNOTES_METADATA_PATH=/etc/globnotes`, instance
data is `/etc/globnotes/_/` and vault data `/etc/globnotes/<name>/`. There is no
per-vault `_INDEX` alias. The loader calculates paths and validates all supplied
scopes, never discovers folders, creates vaults or moves state. The future registry
supplies persisted scopes alongside declarations; declaring one external vault
does not erase saved vaults. Unavailable paths are not silently created.

Plugin deployment settings remain addressed JSON under `plugins.settings`, not
arbitrary TOML plugin tables. Installed plugin schemas still own address/field
validation before workers start. Credentials and ACLs are not vault TOML leaves.

## Persistence boundary

`BoundFileStore` reuses the current server's byte-and-file-binding CAS for both
JSON callers and the upcoming vault TOML owner. File/directory symlinks retain
their identities; replaced targets or external edits cause a conflict. Writes
check target access, preserve ownership/mode, sync a sibling temporary file and
recheck the captured binding before replacement. Owners serialize their writes;
only the owner parses policy and publishes updated state at successful replacement.
Cleanup failures remain errors, including after replacement has already committed.

## Service inputs

Index pacing, directory-cache TTL and hub scan interval are configured in seconds;
the configuration boundary converts them once to milliseconds for their consumers.
Session days become JWT expiry seconds at that boundary. Render workers remain per
vault, so total worker count grows with vault count. Services receive snapshots,
not live environment lookups. The temporary pre-cutover `config/legacy.ts` adapter
preserves existing startup and test inputs until step 8 removes old names.
Runtime images include the shipped defaults required by this preparatory adapter.

The preparatory `VaultConfigStore` saves partial vault TOML through this boundary.
App writes preserve omitted leaves and explicit empty values, and cannot replace
env-pinned leaves (even with the same value). External edits take effect on restart;
interference with an app write is a conflict, never an implicit reload or overwrite.
Invalid TOML is retained. Plugin policy/settings writes still go to their existing
owners, not to a second app-saved TOML copy. Branding images remain in `brand/`.
