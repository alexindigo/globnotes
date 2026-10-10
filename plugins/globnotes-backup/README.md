# Versioned note backups

This server-only plugin saves the **previous Markdown text after** a managed save,
rename or delete. Note changes do not wait for backup delivery/storage: a
successful save can coexist with a failed backup. Empty text is eligible; new
creates have no previous version.

**Adjacent backups are ordinary visible vault files. Public readers can retrieve
old or deleted text through the normal file-serving policy.** Choose a dedicated
base outside the vault if adjacent placement is inappropriate. There is no special
backup-serving/authentication policy.

## Settings and placement

Enable **Versioned note backups** in Settings → Plugins, then open **Backups**.
Retention defaults to **2**, with an integer slider **1–10**. Newest is
`folder/Note.md.0.bak`, followed by `.1.bak`. Reducing the count prunes owned excess
slots on the family's next successful capture; increasing cannot reconstruct old
versions. The plugin rejects near-integer values admitted by generic tolerance,
without rounding, clamping or starting a transaction.

Exactly empty base means adjacent. Relative bases are vault-relative; absolute
bases select that directory. Dedicated bases mirror the original note path:
`/srv/backups/folder/Note.md.0.bak`. No shell/env-string interpolation or cwd fallback.
The selected root's parent must already exist unless separately granted.

Operators can pin non-secret settings at startup:

```sh
GLOBNOTES_PLUGIN_SETTINGS='{"globnotes-backup":{"backup":{"basePath":"/srv/backups"}}}'
```

Environment fields override stored fields/defaults and are visibly readonly.
Explicit `""` pins select adjacent mode. Sibling saves preserve the exact stored
fallback/absence; restart without the pin restores it. Deployment changes need
a restart.

Histories are path-based. Rename captures the original path without moving its
history; later changes at the new name use its family. Delete retains final text
and may recreate adjacent parents. Recreating the same name continues its owned
history. Changing bases does not migrate/delete old histories.

Existing realpath-equivalent `.`, absolute and symlink spellings share a canonical
pathname family. Transactions pin that pathname before staging; alias retargeting
cannot redirect them, though current grants may block completion. This is not a
permanent identity across directory relocation/replacement or distinct bind mounts.

## Status and recovery

The namespaced **Inspect versioned backup status** command and protected
`/_/api/plugins/globnotes-backup/status` route return current-activation counts,
configuration, sanitized last error/operation identity, pending recovery and
committed-ring status. Counts are observations, not a durable global outbox/audit.
Genuine hook failures also reach the host's degraded/delivery diagnostics. No
note text or credentials appear in status.

Ownership records, a fixed active journal and deterministic staging files live in
`<vault>/.globnotes-backup/`. Preserve these when inspecting a failure. Alien slots,
corrupt records and interrupted unowned workspaces are conflicts, never adopted
or deleted by matching names. Records are bounded to 64 KiB, retained slots to10,
admitted jobs to64 and recent dedupe keys to256. Every equal-content save is
distinct; dedupe only suppresses repeated `(operationId,originalPath)` facts.

Discoverable intent precedes staging. Verified staging precedes publication.
Restart resumes old/planned states under current grants; committed rings finish
pruning/cleanup without another rotation or replaying the note. Lost root-creation
acknowledgement is blocked uncertainty; lost unstaged text is an explicit incomplete
capture. Ungranted old external roots retain evidence instead of redirecting writes.

Disable/uninstall never removes histories. Inspect/copy `.bak` files manually;
there is no restore/history UI. Multi-file publication is recoverable, **not
atomic**, and is not a transaction with the completed note change. Tokens are
managed/preparation conflict checks, not external filesystem CAS or power-loss proof.

Uploads, external scans and unavailable/partial preimages do not invent old bytes.
Strings are encoded as UTF-8; invalid UTF-8 input yields reconstructed text, not
byte-exact binary history. The generic 16 MiB body bound fails visibly without
truncation. No scheduler, autosave, attachment history, Git/process permissions or
external-writer interception is added.
