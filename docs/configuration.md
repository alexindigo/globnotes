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
