# Versioned note backups

This server-only legacy v2 plugin keeps the **previous Markdown text** after a
globnotes save, rename or delete commits. The host delivers the displaced bytes
asynchronously through the best-effort versioning hook (docs/hub.md "Versioning").
Staging, publishing the `.bak` slots, rotation and cleanup all run off the save
path. Saves never wait for the plugin. Delivery is bounded in memory; queue
overflow drops the oldest pending entry and records a visible `versioning_gap`.
A successful save can coexist with a pending or failed backup.
Empty text is eligible; new creates have no previous version.

**If the server crashes before the plugin stores a version, that version is not
backed up.** The host writes no spool or journal of note bytes and does not replay
pending delivery after restart. This accepted best-effort limit matches v2
behavior. Future v3 versioning plugins will follow the hub change log (M5/M7).

**Changes made by a versioning plugin are not backed up.** The hub never offers
a versioning plugin's own writes to versioners (preventing recursive backups),
and that applies to every enabled versioning plugin, not just this
one. If another versioning plugin changes or deletes a note, this plugin keeps no
previous text for that change and records no failed offer.

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
GLOBNOTES_GLOBNOTES_PLUGINS_SETTINGS='{"globnotes-backup":{"backup":{"basePath":"/srv/backups"}}}'
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

Startup registers `backup-recovery` through the public service job hook, then
becomes ready without awaiting bulk journal IO. The host admits recovery once
per successful generation, with its ordinary 30-second invocation deadline.
Captures wait for recovery to settle inside the bounded versioning FIFO; saves
and independent protection hooks do not wait for it. No timer or first save is
needed to trigger recovery.

The plugin catalogue's `jobs` record distinguishes pending/running startup work
from succeeded/failed/cancelled recovery. Readiness alone is not completed
recovery. `pendingRecovery` below means an actual unresolved journal was observed,
not that inspection has begun or finished: consult the job state as well. Status
commands/endpoints use the ordinary invocation FIFO and can wait behind recovery.
A recoverable failure retains its failed job record and journal evidence while
keeping a live Worker's status available. Later genuine captures retry recovery
before publishing new bytes; there is no automatic retry or permanent success
gate. Active timeout or retirement revokes old work, not committed effects.

The namespaced **Inspect versioned backup status** command and protected
`/_/api/plugins/globnotes-backup/status` route return current-activation counts,
configuration, sanitized last error/operation identity, pending recovery and
committed-ring status. Counts are observations, not a durable global outbox/audit.
Delivery gaps and failed handlers reach the host's plugin diagnostics
(`versioning_gap`, `versioning_failed`). Processing errors also appear in this
status; journaled work is recovered by the next capture or a restart.
No note text or credentials appear in status.

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

Uploads and creates displace nothing; changes made by other programs are already
on disk when globnotes sees them, so they cannot be offered and leave no backup.
Strings are encoded as UTF-8; invalid UTF-8 input yields reconstructed text, not
byte-exact binary history. Notes over the 16 MiB offer bound are offered without bytes
and fail visibly (`fs_too_large`) without truncation. No scheduler, autosave, attachment history, Git/process permissions or
external-writer interception is added.
