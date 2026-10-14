#!/bin/sh
# Guest-only native entrypoint. One suite owns selection, fixtures and results.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
cd "$ROOT"
exec "${DENO:-deno}" run --cached-only --frozen --config=deno.json \
  --unstable-worker-options --allow-read --allow-write --allow-net \
  --allow-env --allow-run --allow-sys client/tests/e2e/legacy-native-suite.mjs
