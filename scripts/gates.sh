#!/usr/bin/env bash
# The project's checks, run inside the devcontainer (.devcontainer/run.sh).
# One gate list for the pre-commit hook and CI (docs/testing.md):
#   gates.sh --plan STAGED FILES   select checks for a staged change (hook, first run)
#   gates.sh --select SELECTION    run a selection (hook, second run)
#   gates.sh --all [--browser]     run every gate; --browser adds the browser gates
#   gates.sh --timing              the timing-budget tests, serially
# --serial runs the server tests without --parallel.
set -euo pipefail
shopt -s globstar
cd /workspace
: "${TMPDIR:?}" "${GLOBNOTES_TEST_HOST:?}"
logs=/run-logs
artifacts=/artifacts
mkdir -p "$logs" "$artifacts"

usage() {
    printf 'usage: gates.sh --plan STAGED FILES | --select SELECTION [--serial] | --all [--browser] [--serial] | --timing\n' >&2
    exit 2
}
mode="" browser=false serial=false staged="" files="" selection=""
while (($#)); do
    case "$1" in
        --plan) mode=plan; staged="${2:?}"; files="${3:?}"; shift 3 ;;
        --select) mode=select; selection="${2:?}"; shift 2 ;;
        --all) mode=all; shift ;;
        --timing) mode=timing; shift ;;
        --browser) browser=true; shift ;;
        --serial) serial=true; shift ;;
        *) usage ;;
    esac
done
[[ -n "$mode" ]] || usage

test_flags=(--unstable-worker-options --allow-read --allow-write --allow-env --allow-run --allow-net)
script_flags=(--cached-only --frozen --config=deno.json --allow-read --allow-write --allow-env --allow-run)
gate_timeout="${GLOBNOTES_GATE_TIMEOUT:-1800}"
ran=()
failed=""
started="$EPOCHREALTIME"

seconds() {
    local elapsed=$(( ${2/./} - ${1/./} ))
    printf '%d.%06d' "$((elapsed / 1000000))" "$((elapsed % 1000000))"
}
finish() {
    local status=$?
    trap - EXIT
    local verdict=PASS
    ((status == 0)) || verdict=FAIL
    printf '%s %s %ss gates=%s%s\n' "$mode" "$verdict" "$(seconds "$started" "$EPOCHREALTIME")" \
        "$(IFS=,; printf '%s' "${ran[*]}")" "${failed:+ failed=$failed}" >> "$logs/summary.txt"
    exit "$status"
}
trap finish EXIT

# Run a command or one of the functions below under the gate timeout.
bounded() {
    if declare -F "$1" > /dev/null; then
        timeout --kill-after=30 "$gate_timeout" bash -c \
            "set -euo pipefail; shopt -s globstar; $(declare -p test_flags serial); $(declare -f "$1"); \"\$@\"" \
            "$1" "$@"
    else
        timeout --kill-after=30 "$gate_timeout" "$@"
    fi
}

# gate LABEL COMMAND...: log to $logs/LABEL.log, time it, stop on failure.
gate() {
    local label="$1" start end status log_status
    shift
    [[ ! -e "$logs/$label.log" ]] || { printf 'gate %s already ran in this run directory\n' "$label" >&2; return 1; }
    printf '== gate %s\n' "$label"
    ran+=("$label")
    start="$EPOCHREALTIME"
    set +e
    bounded "$@" 2>&1 | tee "$logs/$label.log"
    local statuses=("${PIPESTATUS[@]}")
    set -e
    status="${statuses[0]}"
    log_status="${statuses[1]}"
    end="$EPOCHREALTIME"
    printf '{"gate":"%s","start":%s,"end":%s,"seconds":%s,"exit":%d,"logExit":%d}\n' \
        "$label" "$start" "$end" "$(seconds "$start" "$end")" "$status" "$log_status" >> "$logs/timings.jsonl"
    if [[ "$status" != 0 || "$log_status" != 0 ]]; then
        failed="$label"
        printf '== gate %s FAILED (exit %s); log %s\n' "$label" "$status" "$logs/$label.log" >&2
        return 1
    fi
}

shell_syntax() {
    local file first
    while IFS= read -r -d '' file; do
        IFS= read -r first < "$file" || true
        case "$first" in
            *bash*) bash -n "$file" ;;
            *) sh -n "$file" ;;
        esac
        printf 'ok %s\n' "$file"
    done < <(find . \( -path ./node_modules -o -path ./client/dist -o -path ./.git \) -prune -o \
        -type f \( -name '*.sh' -o -path './.githooks/*' \) -print0 | sort -z)
}
# Link every browser-suite module statically (esbuild, through deno bundle):
# a duplicate binding, a missing module or a missing named export fails here
# without running a script. The suite only loads the scripts it selects.
e2e_modules() {
    local out="$TMPDIR/e2e-modules"
    rm -rf "$out"
    deno bundle --frozen --config=deno.json --external vitest --outdir "$out" \
        client/tests/e2e/*.mjs client/tests/e2e/*.js
    rm -rf "$out"
}
handlers() {
    local file
    while IFS= read -r -d '' file; do
        deno check --cached-only --frozen --config=deno.json "$file"
    done < <(find server/api/endpoints -name '*.ts' -print0 | sort -z)
}
cdp_ready() {
    deno eval 'const r = await fetch("http://127.0.0.1:9335/json/version").catch(() => null);
if (!r?.ok) { console.error("browser gates need the Chromium sidecar: run.sh --browser"); Deno.exit(1); }
console.log(await r.text());'
}
server_tests() {
    if "$serial"; then
        deno test "${test_flags[@]}" "$@"
    else
        DENO_JOBS=4 deno test --parallel "${test_flags[@]}" "$@"
    fi
}

static_gates() {
    gate install deno install
    gate lint deno lint server/ tests/
    gate check deno check server/main.ts tests/**/*.ts
    gate format deno fmt --check server/ tests/
    gate worker deno check --cached-only --frozen --config=deno.json server/plugins/worker_entry.ts
    gate handlers handlers
    gate shell shell_syntax
    gate e2e-modules e2e_modules
    # Never an empty list: `deno test` without paths would run the whole suite.
    if (($#)); then gate contracts deno test "${test_flags[@]}" "$@"; fi
}
build_gates() {
    gate build deno task build:client
    gate cold-load deno run --allow-read --allow-write --allow-env --allow-run --allow-net \
        scripts/cold-load.mjs /workspace commit-check
}
browser_gate() {
    case "$1" in
        native) gate native env DENO=deno GLOBNOTES_E2E_ARTIFACTS="$artifacts/native" sh client/tests/e2e/run.sh ;;
        native-results) gate native-results env GLOBNOTES_E2E_ARTIFACTS="$artifacts/native-results" \
            deno run "${script_flags[@]}" --allow-net --allow-sys client/tests/e2e/native-result-controls.mjs ;;
        native-controls) gate native-controls env GLOBNOTES_E2E_ARTIFACTS="$artifacts/native-controls" \
            deno run "${script_flags[@]}" --unstable-worker-options --allow-net --allow-sys \
            client/tests/e2e/native-consumer-controls.mjs ;;
        entrypoint-results) gate entrypoint-results env GLOBNOTES_E2E_ARTIFACTS="$artifacts/entrypoint-results" \
            deno run "${script_flags[@]}" client/tests/e2e/runner-entrypoint-controls.mjs ;;
    esac
}
unit_controls() {
    gate unit-controls env GLOBNOTES_E2E_ARTIFACTS="$artifacts/unit-controls" \
        deno run "${script_flags[@]}" --allow-sys client/tests/e2e/unit-consumer-controls.mjs
}

field() {
    deno run --cached-only --frozen --config=deno.json --allow-read="$logs" \
        scripts/select-checks.ts --field "$selection" "$1"
}

case "$mode" in
    plan)
        [[ -f "$staged" && -f "$files" ]] || { printf 'missing %s or %s\n' "$staged" "$files" >&2; exit 2; }
        gate plan-install deno install
        gate select bash -c 'deno run --cached-only --frozen --config=deno.json --allow-read --allow-write --allow-run --allow-env \
            scripts/select-checks.ts --staged "$1" --files "$2" > "$3"' select "$staged" "$files" "$logs/selection.json"
        selection="$logs/selection.json"
        if [[ "$(field browser)" == true ]]; then : > "$logs/browser-required"; fi
        printf 'selected: %s\n' "$(field gates | paste -sd, -)"
        ;;
    select)
        unset GLOBNOTES_E2E_CASES
        [[ -f "$selection" ]] || { printf 'missing selection %s\n' "$selection" >&2; exit 2; }
        mapfile -t gates < <(field gates)
        mapfile -t contracts < <(field contractTests)
        selected() { local g; for g in "${gates[@]}"; do [[ "$g" == "$1" ]] && return 0; done; return 1; }
        if [[ "$(field browser)" == true ]]; then gate browser-ready cdp_ready; fi
        static_gates "${contracts[@]}"
        if selected server; then
            mapfile -t tests < <(field serverTests)
            if [[ "${tests[*]}" == all ]]; then tests=(--ignore=tests/timing/ tests/); fi
            gate server server_tests "${tests[@]}"
        fi
        if selected timing; then
            mapfile -t tests < <(field timingTests)
            if [[ "${tests[*]}" == all ]]; then tests=(tests/timing/); fi
            gate timing deno test "${test_flags[@]}" "${tests[@]}"
        fi
        if selected client; then
            mapfile -t related < <(field clientTests)
            if [[ "${related[*]}" == all ]]; then
                gate client env VITEST_MAX_WORKERS=4 deno task test:client
            else
                quoted=""
                for file in "${related[@]}"; do
                    [[ "$file" != *"'"* ]] || { printf 'unsupported path: %s\n' "$file" >&2; exit 1; }
                    quoted+=" '$file'"
                done
                gate client env VITEST_MAX_WORKERS=4 deno task --eval "vitest related --run --passWithNoTests$quoted"
            fi
        fi
        if selected build; then build_gates; fi
        if selected unit-controls; then unit_controls; fi
        if selected native; then
            mapfile -t cases < <(field browserCases)
            if [[ "${cases[*]}" != all ]]; then
                GLOBNOTES_E2E_CASES="$(IFS=,; printf '%s' "${cases[*]}")"
                export GLOBNOTES_E2E_CASES
                printf 'browser cases: %s\n' "$GLOBNOTES_E2E_CASES"
            fi
        fi
        for name in native native-results native-controls entrypoint-results; do
            if selected "$name"; then browser_gate "$name"; fi
        done
        ;;
    all)
        unset GLOBNOTES_E2E_CASES
        if "$browser"; then gate browser-ready cdp_ready; fi
        contracts=()
        for test in tests/test_isolation_contract_test.ts tests/devcontainer_caps_test.ts; do
            [[ ! -f "$test" ]] || contracts+=("$test")
        done
        static_gates "${contracts[@]}"
        gate server server_tests --ignore=tests/timing/ tests/
        gate client env VITEST_MAX_WORKERS=4 deno task test:client
        build_gates
        unit_controls
        if "$browser"; then
            for name in native native-results native-controls entrypoint-results; do browser_gate "$name"; done
        fi
        ;;
    timing)
        gate install deno install
        gate timing deno test "${test_flags[@]}" tests/timing/
        ;;
esac
printf '== all gates passed (%s)\n' "$(IFS=,; printf '%s' "${ran[*]}")"
