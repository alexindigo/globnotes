#!/bin/sh
# Orchestrates the zero-dep e2e suite per the headless-browser-e2e skill:
# a FRESH headless Chromium (Playwright image) per harness, driven over raw
# CDP, with cleanup on exit. The app under test is the instance on :8000.
# Harnesses are stdlib-only ESM (node: builtins only), so Deno runs them
# natively — no separate Node install needed alongside the Deno server.
set -u
# cdp.mjs spawns docker (run) and opens CDP sockets (net); harnesses read
# process.env (env) and the fixtures.* ones touch the vault (read/write/run).
DENO_E2E_PERMS="--allow-read --allow-write --allow-net --allow-run --allow-env --allow-sys"
TESTS="
tour-chain
test-vault
theme
surfaces
code-tokens
copy-button
editor-modes
wikilink-rename
rename-twice
client-driven-links
edit-mode-url
"
PASS=0
FAIL=0
PORT=9400
for t in $TESTS; do
  PORT=$((PORT + 1))
  docker rm -f cdp-browser-$PORT >/dev/null 2>&1 || true
  BROWSER=$(deno run $DENO_E2E_PERMS client/tests/e2e/cdp.mjs launch $PORT 2>/dev/null)
  R=$(CDP_PORT=$PORT BASE_URL=${BASE_URL:-http://localhost:8080} timeout 120 deno run $DENO_E2E_PERMS client/tests/e2e/$t.mjs 2>&1)
  docker rm -f "$BROWSER" >/dev/null 2>&1 || true
  echo "$R" | tail -2
  if echo "$R" | rg -q 'COMPLETE|ALL PAGES OK|ALL THEMES OK|distinct body|FOLLOW THEME: OK|COPY BUTTON OK|back to markdown|WIKILINK RENAME OK|TWO-STEP RENAME OK|CLIENT-DRIVEN LINK UPDATE OK|EDIT MODE URL OK'; then
    PASS=$((PASS + 1))
    echo "PASS $t"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL $t"
  fi
done
for OPT in move relink none; do
  PORT=$((PORT + 1))
  docker rm -f cdp-browser-$PORT >/dev/null 2>&1 || true
  BROWSER=$(deno run $DENO_E2E_PERMS client/tests/e2e/cdp.mjs launch $PORT 2>/dev/null)
  R=$(CDP_PORT=$PORT BASE_URL=${BASE_URL:-http://localhost:8080} timeout 120 deno run $DENO_E2E_PERMS client/tests/e2e/rename-options.mjs $OPT 2>&1)
  docker rm -f "$BROWSER" >/dev/null 2>&1 || true
  echo "$R" | tail -1
  if echo "$R" | rg -q '"dialogVisible":true'; then
    PASS=$((PASS + 1))
    echo "PASS rename-$OPT"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL rename-$OPT"
  fi
done
echo "== suite: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
