# VM-backed local verification

The local Git hooks export the exact staged tree (pre-commit) or each incoming
commit tree (pre-push), copy it to a fresh workspace in the configured VM, and run
CI-equivalent checks plus native browser consumers. Host-side Python performs Git
metadata and transport operations. Installs, linting, type-checks, tests, builds,
cold-load and browser probes execute in the guest.

## Configured development guest

| # | Resource | Current binding |
|---|---|---|
| 1 | VM host | Ark (`ark.home`) |
| 2 | Owned guest | `arch-niri-globnotes-devbase-globnotes-generic-plugin-system` |
| 3 | Guest UUID / MAC | `3c6d1972-c1a1-45fe-b08d-804399a85db4` / `52:54:00:f4:f3:d3` |
| 4 | Account / workspace | `tester`, `/home/tester/generic-plugin-system/test-quality-cleanup/hooks/` |
| 5 | Guest runtime | Isolated Deno 2.9.7; `globnotes.vmDeno` stores its absolute path |
| 6 | Browser | Existing guest Chromium, loopback CDP port 9335; each caller owns a new context/target |
| 7 | Access workflow | `vm-fleet-hosts` → owned `vm-fork` identity verification → `globnotes-vm` / `virsh-vm-shell` |

The shared `vm-transfer` tool independently verifies the pinned host/guest keys,
domain, current guest address, account, rw filesystem and workspace before source
transfer. A missing/mismatched guest blocks validation; there is no host fallback.

## Worktree-local installation

The installer takes a verified user-owned transfer profile, an absolute **guest**
Deno path, and an existing host directory for configuration-preservation receipts:

```sh
python3 -B scripts/install-vm-hooks.py \
  --profile /absolute/path/to/verified-transfer-profile.json \
  --deno /absolute/guest/path/to/deno \
  --evidence /existing/host/evidence/directory
```

Run in the attached `v2` worktree. Installation preserves existing config, enables
Git worktree-local configuration, and binds `.githooks` only to that worktree.
It checks the other worktrees' effective hook/signing/remote/status settings.
An already configured or conflicting hook setup is a reviewable error.

```sh
git hook run pre-commit
python3 -B scripts/verify-in-vm.py pre-push --root "$PWD" --tip-only
```

These are metadata/transport entrypoints on the source-editing host; their actual
workloads run in the named guest. Pre-commit does not stage files automatically.
Pre-push admits only the configured `origin/v2` fast-forward and checks both date
streams against the configured quiet-hours boundary and commit ordering.

## Guest-only browser checks

Inside a newly exported guest source root, with its client already built and the
owned guest browser on CDP 9335:

```sh
CDP_PORT=9335 GLOBNOTES_E2E_ARTIFACTS=/fresh/owned/guest/artifacts \
  deno run --cached-only --frozen --config=deno.json --unstable-worker-options \
  --allow-read --allow-write --allow-net --allow-env --allow-run --allow-sys \
  client/tests/e2e/legacy-native-suite.mjs
```

The suite runs every selected driver serially, including all attachment strategies
and the browser-helper consumers. It records actual child exits and timeout state;
printed PASS/OK words cannot grant success. Missing drivers, startup errors,
unfinished children and failed consumers reject the suite. Clipboard cases restore
the prior guest clipboard without logging its contents. Fixtures retain their
vault/state/server ownership records, API/disk/UI results and failure evidence.

| # | Additional gate | What it observes |
|---|---|---|
| 1 | `native-result-controls.mjs` | Real nonzero children with misleading success output, missing startup, timeout with zero exit, and a completed child |
| 2 | `unit-consumer-controls.mjs` | Broken keymap, Tab and hydration producers in fresh source copies are rejected by their actual tests |
| 3 | `native-consumer-controls.mjs` | Wrong clipboard/token/image/link/identity/tag/palette/visibility/geometry consumers fail; equivalent CSS remains acceptable |
| 4 | Independent filesystem handler checks | Discovered route modules receive type-checking even when main does not statically import them |

All gate units keep the existing serial resource limits: MemoryHigh 384M,
MemoryMax 1G, MemorySwapMax 1G, OOMScoreAdjust 1000, and one client-test worker.
Evidence is retained under `~/Documents/globnotes/validation/` on the editing host
and in separate guest children. Historical/protected source, vaults, profiles and
browser targets are preserved.
