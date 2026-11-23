# Accounts and vault access

Preparatory v3 owners, not yet the production identity path. The current auth
bridge remains active until the coordinated identity cutover.

Accounts belong to the instance metadata root supplied by configuration, not a
vault. `accounts.json` contains versioned records, stable account IDs, normalized
unique logins and an initialized marker. Empty initialized state never means a
fresh public setup. Password hashes and optional authenticator keys are private;
no instance-administrator field exists. The built-in `guest` is not a stored
person; its UI label is "Everybody else".

Repositories reuse bound-file atomic replacement, revision checks and parent
preparation. Slow password preparation occurs before the short synchronous
commit, which rechecks the captured state. A server or offline operator command
holds `identity.lock` exclusively and nonblockingly; the lock inode is never
removed or replaced on release. Filesystem errors retain original state, not an
empty replacement. These owners do not import or modify v2 auth JSON.

The preparatory session owner stores a single instance signing key in
`sessions.json`. HS256 JWTs contain account ID, credential/signing revisions and
expiry, never vault grants. The configured session lifetime is injected from
layered configuration. Password or authenticator changes revoke all of that
account's old tokens; merely consuming a TOTP step does not revoke sessions.
Temporary-password sessions retain a required-change flag for the authority
evaluator; logout clears a browser's token, not another copy of that JWT.

Login accepts separate password and TOTP fields. Authenticator keys retain their
original bytes and +/-1-step window. The matched step is committed before a
successful proof returns, so concurrent and post-restart replay fail. Enrollment
and password hashing share current primitives with the still-active auth bridge.

Each vault's preparatory `access.json` binds an opaque vault ID to saved named
account-ID grants and Everybody else's fallback level. Named None overrides a
permissive fallback; Everybody else may be Edit, View or None, never Admin.
An absent ACL is private by default, not authority to claim an existing folder.

A declaration's admin login is a separate deployment-owned overlay. Unknown
login remains pending without preventing startup. When the account exists it
immediately receives Admin; removing the declaration removes only that overlay,
not saved grants. Creator/adopter ACL preparation is provided for the later
registry workflow, which owns consent and durable publication. No registry or
automatic first-account ownership is created by these repositories.

The preparatory authority factory resolves a request principal once, then checks
its live credential revision/expiry and the concrete vault's ACL/bundle at each
final effect or disclosure. Explicit operation requirements, not HTTP methods,
distinguish View reads, Edit note/file writes and Admin vault administration.
Instance account management and create-vault eligibility need no selected vault.

The new middleware adapter is injected, not enabled at ordinary startup yet.
Its write lease fits the existing NoteOperations final-effect contract and its
settings guard fits the TOML/CAS writer. Read adapters recheck delayed values and
stream enqueue boundaries. Prepared projections and streams (below) are not
routed yet; HTTP activation and plugin propagation are later steps.
Revocation denies pending work, never rolls back an already committed effect or
deletes a browser's unsaved text. Unrelated account/vault revisions do not retire
another lease.

Account preparation can transfer an issued, single-use account into a sealed
publication set with its initialized marker. Setup ACL preparation accepts only a
redacted unrestricted creator. Create-and-add prepares the ACL first, then binds
the account's committed receipt to that exact ACL participant; an account-only
set cannot publish that receipt. Receipt fields retain actor, operation, keyed
payload identity, target, original level and ACL update identity. Neither
preparation activates an account or grant. Reads and competing writes remain
unavailable until the whole set is installed and released. The later identity
transaction still owns its durable journal and recovery, not these adapters.

Native participant validation retains the full P05 authority chain. Its private
account, ACL and session projections read the pre-fence committed runtime state
of that reservation or exact assembled set; public reads and public lease checks
remain fenced. Context is synchronous and cannot be retained for later reads.
All guard callbacks still precede native storage validation and final pure
lifetime fences, including immediately before each file publication. An Admin
grant therefore validates its own committed authority without activating the
prospective grant or reopening outside readers.

Authority callbacks now take a required `AuthorityReadContext`: selection,
lifecycle/service eligibility, principal validation, ACL evaluation and the
session clock receive the same issued context for that check. Its account and
signing projections are redacted and live, not cached eligibility. The context
expires at the end of that check and is not reusable in the next check of the
same publication set. Context-free public reads still refuse custody.

A service callback reads `context.accounts(sessions.accounts).value.initialized`
and `context.signing(sessions.signing).initialized`; its lifecycle adapter must
forward that same context. Ordinary/background evaluation can use
`readAuthorityState(service.operational)`, which always issues an ordinary scoped
context and cannot borrow publication authority from an enclosing callback.

Initial setup can request an authenticator candidate before an account exists.
The aggregate binds it to the current initial owner, normalized login and issuance
attempt. A newer issuance retires the prior attempt, including late QR completion.
Confirmation accepts only the current issued key and persists its marked secret
and accepted step in the prepared initial account. Preparation alone activates
nothing; confirmed enrollment publishes only with the matching creator ACL.
Recorded pair replay requires both recovered participants and uses the exact
prepared account/ACL state under the exclusive offline root owner. It does not
require an in-memory candidate or check a new wall-clock code. Setup screens
and HTTP requests are still inactive here.

Bootstrap sign-in accepts a distinct opaque initial-account proof from the
aggregate, only after its exact initial-account/creator-ACL pair settles. The
trusted initial admission binding supplies a separate completion owner: setup
freshness intentionally ends at publication, while that owner, cancellation,
account, ACL and signing bindings must remain current through signing and response
body consumption. Both proof kinds use the same session signer and guarded body.
The settled set verifies every member's native binding. Bootstrap never verifies
or spends another authenticator code. Single-file,
partial, unreleased or caller-certified publication cannot mint this proof.

Offline account creation has a separate aggregate purpose requiring the real
exclusive recovery authority for its canonical instance root. It prepares a
temporary-password account on a fresh root, a ready root or the approved
signing-only first-account interruption; it never creates or grants a vault.
A persisted uninitialized account record is not that interruption. This purpose
cannot transfer into setup/create-and-add participants or mint a bootstrap proof.
The later CLI adapter still owns paired-state classification, legacy refusal,
configured roots, stdin and signing initialization before account publication.
Reset-password and disable-authenticator keep their existing distinct behavior.

The prepared identity transaction records one versioned `setup` or
`create-and-add` decision for the exact configured account and ACL roots. The
operation must match the prepared participant group. The transaction transfers
the sealed set before attempting the decision, installs both snapshots, retires
the exact journal, then releases admission. Offline recovery can finish
discarding an undecided preparation even if cleanup already removed some or all
of its candidates, provided both targets still match their preimages. An
uncertain decision or incomplete settlement requires exclusive offline recovery
before repositories are exposed. Foreign replacements and changed roots retain
the journal as evidence. This is process-loss recovery, not a machine-power-loss
guarantee, and does not activate account routes or the new setup screens.
`prepareInitial` obtains both sealed participants from its registered repositories
and returns one transaction-issued group. Commit rejects cloned, cross-owner,
reused or differently correlated groups before taking custody; a refused caller
cannot discard another transaction's preparation. The existing aggregate still
owns account preparation and initial-account proof issuance.

Account and ACL repositories accept synchronous observers. The owned publication
calls them only after installation: a single-file change after its write, and a
transaction set after both snapshots are installed and the journal is retired.
An observer failure is reported as `notificationFailed` on the committed outcome,
never as a rejection. Another vault's ACL has its own observers.

The prepared own-account workflow maps GET, PATCH and authenticator enrollment
to the credential aggregate. It requires the current password and, when enabled,
a fresh current authenticator code. Only the current issued enrollment can be
confirmed. Temporary passwords must be replaced, not submitted again as the new
password. Account-local revision and update ID prevent stale or repeated changes.
No target-account field, replacement token or credential-outcome endpoint exists.
The exact committed acknowledgment survives its own credential revocation, but
not replacement of the captured instance lifetime. Lost replies use normal sign-in.
These account handlers are injection-only until the coordinated cutover.

While the legacy setup and Access screens remain active, their service owns one
current enrollment attempt per lane and config owner through QR rendering and
confirmation; a new issuance replaces only that lane's attempt. Newly confirmed
secrets carry an explicit Base32 marker. Existing unmarked/raw stored secrets keep
their historical interpretation; keeping an authenticator does not rewrite it.

## Prepared projections and streams

`createIdentityComposition` takes an explicit live lifetime from its caller and
binds one concrete ACL/vault, the instance sessions and a plugin lifecycle whose
service eligibility comes from the instance (initialized accounts and signing),
not from any browser's access.
The lifecycle forwards each issued authority read context to service eligibility;
ordinary/background queries open a separate ordinary read scope. Eligibility
reads current initialized-account and signing-readiness projections through that
context, never a cached result or a context-free read during paired publication.
Status, configuration and catalog responses are
allowlisted values delivered through the issued lease's lazy JSON body. A reader
gets enabled plugin contribution descriptors, not a filtered administrative
inventory. None and guests without access get an instance-only status without a
vault ID, so a later ACL change does not fence it, but credential retirement does.

The prepared vault-change and plugin-event streams use the same target-bound read
lease for every poll body and SSE chunk. Readers do not receive change peers,
driver revisions or settings/driver invalidations. An account, concrete-vault ACL
or policy change, lifecycle epoch, session expiry, request abort or cancellation
closes the stream and releases its listeners and timers; a request aborted before
or during admission registers none. Retiring the composition lifetime fences
delivery. Production still uses the legacy routes until the coordinated cutover.

## Prepared setup and first-account seed

The prepared setup workflow creates one unrestricted account, its initialized
marker and its one target's explicit creator Admin plus the submitted Everybody
else Edit/View/None level. Signing state is initialized first. Only the settled
account/ACL pair can issue the existing session handoff; its final JSON body also
contains `setupRequired: false`, `vaultId` and `everybody`. Enrollment alone is
inert. No new setup route or screen is active until the coordinated cutover.

The instance schema now accepts these one-time seed leaves through normal
defaults/TOML/environment precedence:

```toml
[accounts.first]
login = ""
password = ""
```

Their environment names are `GLOBNOTES__ACCOUNTS_FIRST_LOGIN` and
`GLOBNOTES__ACCOUNTS_FIRST_PASSWORD`. Supply both or neither; passwords retain
their exact spaces. Diagnostics identify keys and sources, never their values.
Protect the file/environment and remove the seed after use. JavaScript does not
promise memory erasure. The prepared boot adapter applies it once before public
admission; production boot wiring remains in the coordinated cutover.
Ready stores ignore seed changes/removal without comparing/resetting credentials
or making a second account. Incomplete, corrupt and recognized unimported legacy
state require explicit recovery/migration, never silent seed repair.

A configured account gets no implicit vault grant. For a configured first account
to administer the existing target, also set its separate declaration, for example
`GLOBNOTES_GLOBNOTES_PATH=/notes` and `GLOBNOTES_GLOBNOTES_ADMIN=alice`. Otherwise
ordinary saved/fallback access applies; the person's own account remains reachable.

## Offline commands

The new offline CLI is directly runnable against compatible v3 stores. Stop the
owning instance using your deployment's normal procedure first. Inside that
deployment's container/workspace, use `GLOBNOTES_CONFIG` and the same configured
paths as the instance; run `deno run --allow-read --allow-write --allow-env
--allow-net server/auth/cli.ts` followed by the command below. This is not an HTTP
administrator or permission to stop host services.

| # | Command | Outcome |
|---|---|---|
| 1 | `account create --login NAME --password-stdin` | Temporary-password account, no vault grant; deliberately finishes a signing-only first-account interruption |
| 2 | `account reset-password --login NAME --password-stdin` | Temporary replacement password; original authenticator interpretation and replay floor retained |
| 3 | `account disable-totp --login NAME` | Clears authenticator/floor without changing the password |
| 4 | `vault grant-admin --vault globnotes --login NAME` | Grants an existing account Admin on the existing configured target only |

If the vault has no saved ACL, `grant-admin` starts with Everybody else set to
None and uses the persisted single-vault ID that web setup uses. It does not
create a notes directory or adopt another vault.

Passwords arrive as one nonempty stdin line, never an argv option or printed
result. Command summaries contain only operation/account/update identities and
the committed result. A live owner causes immediate refusal, not queued later
execution. Recorded decisions recover under the same exclusive owner before
another command runs. Corrupt stores and unimported legacy data are not repaired
or imported. Reset/disable revoke only that account's old tokens; other accounts
and the signing key are unchanged.

## Prepared vault access workflows

These prepared workflows are not yet on the active route tree; the current
Access screen keeps using the existing settings until the coordinated cutover.
Snapshots, exact-login resolution and edits require live Admin on that target
vault. A named None overrides Everybody else; a declared Admin is separate and
is never saved as a grant. There is no last-admin veto. Self-demotion returns
only a safe acknowledgment and the actor's current capabilities. An actor-bound
status read tells a demoted account whether its own update is current, without
the list or another person's edit. Before sending any vault Access or
provisioning response, the server rechecks the session, vault binding, ACL and
operational state. Re-request a stale snapshot or exact-login result only if you
still have Admin. If an edit acknowledgment is lost, use its actor-bound status
read instead of replaying the edit.

Create and add publishes the temporary account, its committed receipt and the
named grant as one recorded decision with the target Admin checked from
preparation through that decision. Before the decision neither changes; after
it, recovery completes both before admission. Its reply is
`{operationId, accountId, committed: true}`, never a partial result. An exact
retry requires current Admin on the same vault and acknowledges the original
account without resetting its password or restoring a later-removed grant. A
demoted actor who is still signed in can use the actor-bound status read with
the original operation ID to recover that acknowledgment without Admin.
Changed payloads, another actor or vault and existing logins conflict. Receipts
keep a keyed payload identity, never the temporary password or its unkeyed
digest. A known-ID status read waits for the admitted operation to settle; a
missing receipt while it hashes is not failure.
An aborted retry or status request stops waiting without cancelling the admitted
operation. Unresolved publication reports unavailable state, never a false
noncommit. If staged writes cannot be discarded before the journal is written,
the transaction retains their reservations for offline recovery.

## Prepared HTTP access requirements

Every discovered endpoint declares the operation it requires (`public`,
`session`, `manageOwnAccount`, `createVault`, `readVault`, `editNotes`,
`manageVault`, `shellOrFile` or `mcp`). The prepared middleware admits from that
declaration and the concrete vault target, never from the HTTP method: a missing
declaration is refused, administrative GETs need Admin and render POST needs
View. Read responses, including HEAD, conditional, range and bodyless replies,
are checked again when their status and each body chunk are delivered. A
refusal replaces the private reply and releases its source when the refusal
itself is read or cancelled. Note writes and Access receipts keep their own
acknowledgments.

Direct and API file reads share one read lease. MCP captures each caller's own
access and takes a per-tool lease, so a View caller keeps the read tools while
another account can edit. Read replies are rechecked at delivery; a reply that
carries a committed write stays its acknowledgment. These adapters are
injection-only; the existing production composition stays active until the
coordinated cutover.

## Prepared browser session

The injected browser session derives access from the safe capability projection,
not an auth mode or the presence of a token. Its live key includes account/guest,
session generation, vault and authority revision. Reader runtime eligibility is
separate from Admin inventory/review. Named sign-in remains available on public
vaults, and own-account navigation does not require vault read access.

`tokenStorage` owns prefix-qualified storage and cookie writes. The shared prefix
codec supplies the default cookie name to the prepared server composition. It
does not import, delete or fall back to old `token` keys/cookies. Cookies remain
usable on ordinary local-domain HTTP. Browser logout clears only this instance's
local credentials after Save/Discard/Cancel participants permit departure.

G5 owns admitted reads, sign-in/logout completion, stream callbacks and original
note/Settings write custody. Credential replacement fences live delivery without
dropping original work from settlement/disposal. An original successful write
retains its acknowledgment even when its live UI is retired; it is not relabeled
unknown or resent under the replacement credential. Dirty editors and Settings
drafts remain with their original owner. Browsing caches, search results and
draft storage are identity-qualified. Recovery reads outlive retired stream
access, but cannot restore another credential attempt.

These factories and capability-aware consumers are prepared only. The existing
App/router/auth wiring remains active; account screens and production identity
activation belong to the coordinated cutover.
