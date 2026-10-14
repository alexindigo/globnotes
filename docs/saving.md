# Saving notes

Each editing session owns a FIFO save queue. Clicking **Save** captures the
current content and filename immediately. If an earlier Save is still running,
the new snapshot waits behind it. Every click remains a separate Save, including
equal-content clicks; intermediate snapshots are not skipped or replaced.

You can continue editing and clicking Save while ordinary saving is active.
The Save label stays unchanged; its icon spins while the pipeline is preparing
or sending work. Adjacent status text reports queued work. A response confirms
only the snapshot it saved: it cannot replace newer edits or falsely mark them
clean. Preview uses its retained buffer; an editor still initializing does not
replace that buffer with an empty placeholder.

## Paused saves

A rejected request, cancelled attachment choice or uncertain write pauses the
queue and restores the Save icon. Failed and queued snapshots, current text and
filename intent remain retained. Further Save clicks capture additional held
snapshots and report that they are held. They do not retry, resume or skip the
failed work.

A 60-second observation deadline is not cancellation of a server write. A late
reply belongs to its original editing session and submission. It cannot resume
held snapshots or execute an earlier aborted close/logout request. A network
error, partial operation or unproven error response can leave the outcome
unknown; receiving an error does not by itself prove that files were untouched.

The initial FIFO implementation provides no Retry/Resume/Skip controls, automatic
reconciliation, persistent outbox or crash-safe replay.

## Leaving an editing session

Logout, Access Finish, navigation, close/edit-exit and Delete wait for owned
pending saves within a bound. Credentials and the editor remain available until
the write outcome and newer unsaved work are resolved. A failure encountered
while waiting aborts that attempt. Successful settlement is followed by the
existing Save/Discard/Cancel decision if newer work remains.

Configured Access updates are in place, not a setup reset. Password/2FA changes
retire sessions only after the admitted work is resolved and the access update
commits; a new authenticator must first be confirmed. An uncertain Access response
retains its wire/choices and requires explicit persisted-update read-back before
retry or handoff. A public settings-only lock leaves note saving available.

A known Access conflict also requires **Review current access** before a separate
explicit Save. Review refreshes current account/proof requirements and its CAS
while retaining proposed credentials, mode/lock choices and enrolment bundle. It
does not generate another bundle, resolve participants or write access policy.

Pending inventory enablement/auto-enable, declarative settings and permission work
participate in the existing Settings/session handoff. Observation deadlines do not
cancel their original wires. Explicit current-state review precedes uncertain
recovery; a late acknowledgement does not revive an aborted handoff.

On a later attempt, known-settled or unsent paused work can reach an explicitly
disclosed Discard/Cancel decision. Discard removes held snapshots and current
unsaved changes; it cannot cancel an in-flight or unknown write. Unknown outcomes
continue to block unsafe handoffs. Browser unload cannot await the queue, so
unresolved work retains the before-unload warning and the existing latest draft.

## Renames and attachments

Queued saves use the last acknowledged server path as their source. A new note
is created once; subsequent snapshots update its actual returned identity.
Canonical server paths do not override newer explicit filename intent. Each
queued content snapshot stays literal, even when an earlier response normalized
an H1 or attachment link.

Toolbar folder moves use the existing attachment chooser. Its preview describes
references in persisted content, not an invented preview of queued text. Preview
errors and cancellation settle preparation without sending a mutation and pause
the retained queue. Navigation/session saves retain their existing `none`
attachment strategy.

## Server admission and actual effects

HTTP note/file mutations retain their original verified request authority through
body preparation, queue/guard waits and the final storage effect. A later auth
rotation or protection change cannot lend an old request a new epoch. Read-only
notes, setup and token expiry still deny writes; the public settings-only lock
remains independent of note writability.

Upload preparation discloses one selected collision name and canonical destination.
The commit re-resolves the original logical directory and rejects a retargeted or
newly occupied destination before effects; it does not silently choose a new name.

After storage/index/cache/fact reconciliation, each managed operation with actual
effects admits one nonblocking server sync boundary. Combined rename/save and
reference rewrites use one operation boundary; completed partial effects are
included, desired-but-unexecuted paths are not. No-effect/private-data operations
produce no such sync. Later index scans acknowledge managed signatures without
duplicating that boundary, while genuine external changes still synchronize.
