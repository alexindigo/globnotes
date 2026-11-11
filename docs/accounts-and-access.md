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
