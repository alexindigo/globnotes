#!/bin/sh
# Orchestrates the zero-dep e2e suite: the app container on :8000 plus a
# headless Chromium (Playwright image) driven over raw CDP. Cleans up the
# browser container on exit.
set -e
CDP_PORT=${CDP_PORT:-9333}
BROWSER=""
cleanup() {
  [ -n "$BROWSER" ] && docker rm -f "$BROWSER" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Starting browser (CDP :$CDP_PORT)..."
BROWSER=$(node client/tests/e2e/cdp.mjs --launch "$CDP_PORT")
export CDP_PORT
echo "Running suite..."
for t in "$@"; do
  echo "=== $t ==="
  node "$t" || echo "FAILED: $t"
done
echo "Done."
