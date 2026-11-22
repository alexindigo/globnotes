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
stream enqueue boundaries; actual HTTP/SSE and plugin propagation are later steps.
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
