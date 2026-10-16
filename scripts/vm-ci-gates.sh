#!/usr/bin/env bash
# Workloads execute only in the independently UUID/MAC-verified guest.
set -euo pipefail
: "${WORK:?}" "${DENO:?}" "${VALIDATED_VM_UUID:?}"
test "$VALIDATED_VM_UUID" = 3c6d1972-c1a1-45fe-b08d-804399a85db4
test "$(id -u)" = 1000
case "$WORK" in /home/tester/generic-plugin-system/test-quality-cleanup/hooks/*) ;; *) exit 1;; esac
ROOT="$WORK/source"
export PATH="$(dirname "$DENO"):/home/tester/.deno/bin:/usr/local/bin:/usr/bin"
export NO_COLOR=1 VITEST_MAX_WORKERS=1 CDP_PORT=9335
# Browser tests open the app only on this VM's local HTTP domain (docs/vm-testing.md).
export GLOBNOTES_TEST_HOST=generic-plugin-system-globnotes.test
test_address=$(getent ahostsv4 "$GLOBNOTES_TEST_HOST" | awk '{print $1}' | sort -u)
case "$test_address" in
  "" | *[!0-9.]* | 127.*) echo "$GLOBNOTES_TEST_HOST must resolve to one non-loopback IPv4 address" >&2; exit 1 ;;
esac
ip -4 -o addr show scope global | grep -qF " inet $test_address/" ||
  { echo "$GLOBNOTES_TEST_HOST resolves to $test_address, not an address of this VM" >&2; exit 1; }
export TMPDIR="$WORK/tmp"
mkdir -m 700 "$TMPDIR"
python3 -B "$WORK/inputs/source-check.py" "$WORK" extract
gate() {
  local label="$1" command_status log_status
  shift
  test ! -e "$WORK/logs/$label.log"
  set +e
  systemd-run --user --unit="globnotes-hook-$(basename "$WORK")-$label" --wait --pipe \
    -p MemoryHigh=384M -p MemoryMax=1G -p MemorySwapMax=1G -p OOMScoreAdjust=1000 \
    --working-directory="$ROOT" env PATH="$PATH" GLOBNOTES_TEST_HOST="$GLOBNOTES_TEST_HOST" TMPDIR="$TMPDIR" NO_COLOR=1 VITEST_MAX_WORKERS=1 CDP_PORT=9335 "$@" \
    2>&1 | tee "$WORK/logs/$label.log"
  statuses=("${PIPESTATUS[@]}")
  command_status="${statuses[0]}"; log_status="${statuses[1]}"
  set -e
  printf 'command=%s log=%s\n' "$command_status" "$log_status" > "$WORK/logs/$label.exit"
  test "$command_status" = 0 && test "$log_status" = 0
}
finish() { python3 -B "$WORK/inputs/source-check.py" "$WORK" verify; }
trap finish EXIT
gate version "$DENO" --version
gate install "$DENO" install
gate lint "$DENO" lint server/ tests/
gate check bash -c 'deno check server/main.ts tests/**/*.ts'
gate server "$DENO" test --unstable-worker-options --allow-read --allow-write --allow-env --allow-run --allow-net tests/
gate client "$DENO" task test:client
gate build "$DENO" task build:client
gate format "$DENO" fmt --check server/ tests/
gate worker "$DENO" check --cached-only --frozen --config=deno.json server/plugins/worker_entry.ts
gate handlers bash -c 'set -e; while IFS= read -r -d "" file; do deno check --cached-only --frozen --config=deno.json "$file"; done < <(find server/api/endpoints -name "*.ts" -print0)'
gate shell sh -n entrypoint.sh
gate cold-load env ROOT="$ROOT" LABEL="hook-$(basename "$WORK")" "$DENO" run \
  --cached-only --frozen --config="$ROOT/deno.json" --unstable-worker-options \
  --allow-read --allow-write --allow-net --allow-env --allow-run /home/tester/v22-release/scripts/cold-load.mjs "$ROOT" "hook-$(basename "$WORK")"
gate native-shell sh -n client/tests/e2e/run.sh
gate native env DENO="$DENO" GLOBNOTES_E2E_ARTIFACTS="$WORK/artifacts/native" sh client/tests/e2e/run.sh
gate native-results env GLOBNOTES_E2E_ARTIFACTS="$WORK/artifacts/native-results" "$DENO" run \
  --cached-only --frozen --config=deno.json --allow-read --allow-write --allow-net \
  --allow-env --allow-run --allow-sys client/tests/e2e/native-result-controls.mjs
gate unit-controls env GLOBNOTES_E2E_ARTIFACTS="$WORK/artifacts/unit-controls" "$DENO" run \
  --cached-only --frozen --config=deno.json --allow-read --allow-write --allow-env \
  --allow-run --allow-sys client/tests/e2e/unit-consumer-controls.mjs
gate native-controls env GLOBNOTES_E2E_ARTIFACTS="$WORK/artifacts/native-controls" "$DENO" run \
  --cached-only --frozen --config=deno.json --unstable-worker-options \
  --allow-read --allow-write --allow-net --allow-env --allow-run --allow-sys client/tests/e2e/native-consumer-controls.mjs
gate native-entrypoint-results env GLOBNOTES_E2E_ARTIFACTS="$WORK/artifacts/entrypoint-results" "$DENO" run \
  --cached-only --frozen --config=deno.json --allow-read --allow-write \
  --allow-env --allow-run client/tests/e2e/runner-entrypoint-controls.mjs
