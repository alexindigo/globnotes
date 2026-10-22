# Saving notes

Each editing session owns a FIFO save queue. **Save** captures the current text
and writes it to the current file. It never leaves edit mode, opens the attachment
chooser or remembers an editor-mode preference. Switching editor modes remembers
the preference instead. A new note's first Save creates its requested name
(`Untitled` / `Untitled N`, or the first heading while its title is untouched).

Save is a no-op outside edit mode or when the buffer equals the latest submitted
snapshot: the last queued job, otherwise the active job, otherwise acknowledged
content. Equal-content clicks produce no request, write, on-save hook or backup,
including when the queue is paused. Different snapshots remain FIFO jobs;
intermediate snapshots are not skipped or replaced. Completed payloads are retired
after receipt and integration; the acknowledged base and unresolved work remain.

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

**Exit edit** is separate from Save. **Save & close** and the Save Changes dialog's
Save save the text, await settlement and then exit edit or commit navigation.
Before navigation, logout or exit, pending title/folder input is applied as a
rename; an invalid name blocks with its validation error. Discard restores only
text to the acknowledged content; an already-applied rename remains applied.

The Save indicator, unload warning, Save Changes prompt and `note:edit-state`
share one unsaved fact: buffer differs from the latest submitted content, or the
queue has unresolved work. Unapplied filename input is not unsaved text.

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
Canonical server paths do not override newer explicit filename intent. Snapshots
stay literal: a rename response is never automatically merged into newer text.
If the server returns different text (including an H1 or attachment-link rewrite)
while newer live text or queued jobs exist, automatic saving stops at a retained
reconciliation barrier. This includes plain prose, repeated path segments, and
new/copied references: a text diff cannot certify their path coordinates. Queued
jobs behind that rename remain held and unchanged. An unchanged live sent base
can take the acknowledgement; queued jobs still need an explicit decision.

Title and folder fields apply on **Enter or blur**, through one controller rename
intent. Typing alone does not send a request; Save does not apply a rename.
Before a new note is created, applying its name only changes its requested path.
Invalid names retain the field's text and send nothing.

Rename jobs use the same FIFO and carry the current buffer and requested path.
Server attachment-link rewrites are acknowledged into the editor, so the next
Save uses those links. Both editor ports must accept acknowledgements without
reporting them as user edits; an initializing editor retains the acknowledged
buffer. Acknowledgements apply as separate narrow changes, not one first-to-last
replacement. Each editor maps selection and history through those changes, with
the acknowledgement excluded from user undo history. WYSIWYG compares its serialized document to its own loaded baseline and
exposes the original bytes until an actual edit changes that serialization.

If a transformed rename encounters newer text, the user's text and queued jobs
are retained, a message asks them to review the references, and `canSave` becomes
false so autosave stops. An explicit **Save** accepts the user's text as-is and
releases only this reconciliation barrier: already queued snapshots retain their
FIFO order and literal text, followed by the current text if different.
It never resumes a failed or uncertain write. A settled, known-committed conflict
can reach Save/Discard/Cancel on exit-edit, Delete, navigation and session handoff
(Logout/Access). Discard restores the acknowledged renamed content and removes
held work without another write; Cancel retains everything. In-flight or unknown
write outcomes still block unsafe handoffs. Folder moves use the existing attachment chooser. Its preview describes
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
