# Remotely Save

Connect an existing Remotely Save v3 store to globnotes through Settings ->
Sync. The plugin uses the storage SDK; the hub owns vault writes, conflict
copies, deleted-here review and empty-remote protection. No vault copy, remote
metadata file or second sync scheduler is created.

## Setup

Enable the plugin, approve its server network access in Plugins, then add a
Remotely Save instance in Sync. Configure it while off, enter the needed keys
and turn it on. Keys are write-only, per instance, and can be entered over the
ordinary local HTTP connection. Unused backend keys can remain unset.

| # | Setting    | Match the existing setup                                                                                                                   |
| - | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 | S3         | HTTP(S) endpoint without bucket, region, bucket, remote prefix and path-style choice. Virtual-host addressing is the Remotely Save default |
| 2 | WebDAV     | Server URL and explicit remoteBaseDir. No globnotes vault-name suffix is added. Anonymous, Basic or Digest authentication                  |
| 3 | Encryption | None, OpenSSL base64, or rclone base64. OpenSSL also reads older base32 names. The plugin never converts or rotates a remote               |
| 4 | Exclusions | One literal vault-relative prefix per line. Case and spelling count; dotfiles have no implicit exclusion                                   |

Use the normalized root actually used by Remotely Save. Outer slashes are
normalized; ambiguous interior/traversal paths and credential-bearing URLs are
rejected. Credentials and encryption passwords belong in Keys, not URLs or
ordinary fields.

## Compatibility and limits

The format reference is Remotely Save 0.5.25, source revision
`34db181af002f8d71ea0a87e7965abc57b294914`, using its v3 sync algorithm. The
plugin implements OpenSSL framing independently with WebCrypto and uses the
pinned published `@fyears/rclone-crypt@0.0.7` codec with `Cipher("base64")` and
the empty second password/default salt. No Obsidian process, copied sync engine
or external driver program runs in production.

Legacy `_remotely-save-metadata-on-remote.json` and `.bin` objects are reserved
after decoding names. Their bytes remain untouched, including malformed or
unknown legacy deletion records. Current v3 ignores those records; they are not
deletion authority here. Pre-v3 deletion synchronization is not claimed. Folder
markers are preserved; empty-directory mirroring is not implemented.

Encrypted names are rebuilt into a transient lookup from a complete inventory.
Updates/deletes reuse the observed native name. Duplicate decoded names, NFC
aliases, mixed formats, wrong keys and corrupt required data stop discovery
before any known files are exposed. An empty encrypted store cannot validate a
password. OpenSSL CBC has no authentication tag; valid padding does not
authenticate a password or file. Rclone body chunks verify their tags.

Files are limited to 16 MiB of plaintext, with bounded encryption overhead.
Larger remote objects remain visible as unsupported; they are not truncated or
inferred absent. Revisions and cursor handles are path-free; keys and decoded
names are not persisted by the driver.

S3's 1024-byte native-key limit includes the configured prefix and encrypted
name expansion. Unrepresentable outgoing names are reported as unsupported
before dispatch; they are never truncated or renamed. WebDAV outgoing native
segments are limited to 255 UTF-8 bytes for portable filesystem-backed storage.
The limit includes encryption expansion: OpenSSL's entire path becomes one
segment, while rclone retains encrypted directories.

Storage mutations are conservatively advertised as emulated. The SDK freshly
checks the base and the provider uses strong native ETag conditions when
available. A concurrent writer can still race a backend without dependable
conditions. Random OpenSSL names also allow another client to create a second
salted alias between canonical absence lookup and upload. Do not treat this as
universal atomic compare-and-swap.

The hub preserves collisions as sibling copies/inbox records, without inventing
a merge base or copying Remotely Save's keep-newer/keep-larger choices. Native
`.dup` alternatives remain independent files. A failed or lost mutation reply is
not retried inside the provider; the hub observes it before recovery. Digest
authentication can refresh one expired nonce after an explicit stale 401
rejection. That is not a retry of an ambiguous mutation.

Uploads use server-observed upload time, not the original filesystem mtime. S3
creation metadata is retained when available. Same-size replacements wait for a
later observed server-time tick, recheck the base and require returned
modification time to advance. If the server cannot establish that, the instance
reports failure/uncertainty rather than promising that Remotely Save detects it.
The S3 fence covers both server Last-Modified and client MTime metadata,
including legacy millisecond values used by accurate-mtime Remotely Save
clients.

Endpoint identity binds normalized backend/root/encryption configuration, not
credentials. Replacing a store at the same address is not distinguishable from
the original incarnation: Remotely Save supplies no reliable incarnation marker.
The hub's empty-remote review remains necessary. Encryption protects the remote;
the live globnotes vault and other drivers still receive plaintext.
