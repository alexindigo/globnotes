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
