#!/usr/bin/env bash
# Run all project workloads in a capped container; CDP never leaves its network.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
source_dir="$ROOT"
run_dir=""
browser=false
step_label=initialization
step_log=""
name=""
chromium_name=""
dev_started=false
chromium_started=false
step() {
    step_label="$1"
    step_log="$run_dir/logs/$2"
}
run_step() {
    step "$1" "$2"
    shift 2
    "$@" > "$step_log" 2>&1
}
cleanup() {
    local status=$?
    trap - EXIT INT TERM
    if "$chromium_started"; then
        timeout 15 "$engine" inspect "$chromium_name" > "$run_dir/logs/final-chromium.json" 2>&1 || true
        timeout 20 "$engine" stop --time 5 "$chromium_name" > "$run_dir/logs/stop-chromium.log" 2>&1 || true
        timeout 15 "$engine" logs "$chromium_name" > "$run_dir/logs/chromium.log" 2>&1 || true
        timeout 20 "$engine" rm --force "$chromium_name" > "$run_dir/logs/remove-chromium.log" 2>&1 || true
    fi
    if "$dev_started"; then
        timeout 20 "$engine" stop --time 5 "$name" > "$run_dir/logs/stop-dev.log" 2>&1 || true
    fi
    if ((status != 0)); then
        printf 'globnotes-run: step=%s failed (exit %s); run directory %s\n' "$step_label" "$status" "${run_dir:-not created}" >&2
        for log in "$step_log" "${run_dir:+$run_dir/logs/chromium.log}"; do
            if [[ -n "$log" && -f "$log" ]]; then
                printf 'globnotes-run: last 80 lines of %s\n' "$log" >&2
                timeout 5 tail -n 80 -- "$log" >&2 || true
            fi
        done
    fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
fail() { printf 'globnotes-run: %s\n' "$*" >&2; exit 1; }
while (($#)); do
    case "$1" in
        --browser) browser=true; shift ;;
        --source) source_dir="${2:?--source needs a directory}"; shift 2 ;;
        --run-dir) run_dir="${2:?--run-dir needs a directory}"; shift 2 ;;
        --) shift; break ;;
        *) fail "unknown option: $1" ;;
    esac
done
(($#)) || fail 'usage: run.sh [--browser] [--source DIR] [--run-dir DIR] -- COMMAND [ARG...]'

if [[ -n "${GLOBNOTES_CONTAINER_ENGINE:-}" ]]; then
    case "$GLOBNOTES_CONTAINER_ENGINE" in podman|docker) engine="$GLOBNOTES_CONTAINER_ENGINE" ;; *) fail 'engine must be podman or docker' ;; esac
elif command -v podman >/dev/null; then
    engine=podman
elif command -v docker >/dev/null; then
    engine=docker
else
    fail 'no container engine available'
fi
engine_version="$(timeout 15 "$engine" --version)"
case "$engine_version" in
    'podman version '*) backend=podman ;;
    'Docker version '*) backend=docker ;;
    *) fail "unsupported engine: $engine_version" ;;
esac
if [[ "$backend" == podman ]]; then
    [[ "$(timeout 20 "$engine" info --format '{{.Host.Security.Rootless}}')" == true ]] || fail 'rootless Podman required'
fi
printf 'globnotes-run: engine=%s backend=%s\n' "$engine" "$backend" >&2

source_dir="$(realpath -- "$source_dir")"
[[ -d "$source_dir" ]] || fail 'source directory missing'
if [[ -z "$run_dir" ]]; then
    mkdir -p "$HOME/.cache/globnotes-run"
    run_dir="$(mktemp -d "$HOME/.cache/globnotes-run/run.XXXXXXXX")"
fi
mkdir -p "$run_dir" "$run_dir/tmp" "$run_dir/logs" "$run_dir/artifacts"
run_dir="$(realpath -- "$run_dir")"
[[ "$source_dir" != /tmp && "$source_dir" != /tmp/* && "$run_dir" != /tmp && "$run_dir" != /tmp/* ]] || fail 'host /tmp is not a workspace'
# Podman/buildah also use disk-backed scratch during builds and pulls.
mkdir -p "$run_dir/engine-tmp"
export TMPDIR="$run_dir/engine-tmp"
export GLOBNOTES_CONTAINER_ENGINE="$engine"

# Build caps: Podman and the legacy Docker builder take --memory; BuildKit's
# docker build takes --resource where its daemon supports per-step limits.
build_caps=(--memory=4g)
if [[ "$backend" == docker ]]; then
    build_help="$(timeout 20 "$engine" build --help 2>&1)" || build_help=""
    if [[ "$build_help" == *--memory* ]]; then
        build_caps=(--memory=4g)
    elif [[ "$build_help" == *--resource* ]]; then
        build_caps=(--resource memory=4g --resource memory-swap=4g)
    else
        build_caps=()
    fi
fi
printf 'build caps: %s\n' "${build_caps[*]:-none (engine has no build resource flag)}" > "$run_dir/logs/build-caps.txt"

build_image() {
    local kind="$1" file="$2" hash start end elapsed image status
    run_step "hash-$kind-image" "hash-$kind.log" sha256sum "$file"
    read -r hash _ < "$step_log"
    hash="${hash:0:16}"
    image="localhost/globnotes-$kind:$hash"
    start="$EPOCHREALTIME"
    if timeout 20 "$engine" image inspect "$image" >/dev/null 2>&1; then
        printf '{"image":"%s","built":false,"seconds":0}\n' "$image" >> "$run_dir/logs/build-timings.jsonl"
    else
        step "build-$kind-image" "build-$kind.log"
        status=0
        timeout 1200 "$engine" build "${build_caps[@]}" --file "$file" --tag "$image" "$(dirname "$file")" > "$run_dir/logs/build-$kind.log" 2>&1 || status=$?
        end="$EPOCHREALTIME"
        elapsed=$(( ${end/./} - ${start/./} ))
        printf '{"image":"%s","built":true,"seconds":%d.%06d,"exit":%d}\n' "$image" "$((elapsed / 1000000))" "$((elapsed % 1000000))" "$status" >> "$run_dir/logs/build-timings.jsonl"
        if ((status != 0)); then
            printf 'globnotes-run: image build failed; see %s\n' "$run_dir/logs/build-$kind.log" >&2
            return "$status"
        fi
    fi
    run_step "inspect-$kind-image" "image-$kind.json" timeout 20 "$engine" image inspect "$image"
    built_image="$image"
}
build_image dev "$ROOT/.devcontainer/Dockerfile"
dev_image="$built_image"
chromium_image=""
if "$browser"; then
    build_image chromium "$ROOT/.devcontainer/chromium/Dockerfile"
    chromium_image="$built_image"
fi
if [[ "$backend" == podman ]]; then
    timeout 15 "$engine" network exists globnotes-test || run_step create-network network-create.log timeout 20 "$engine" network create globnotes-test
else
    timeout 15 "$engine" network inspect globnotes-test >/dev/null 2>&1 || run_step create-network network-create.log timeout 20 "$engine" network create globnotes-test
fi

step configure-dev-container configure-dev.log
DEV_CAPS=(--memory=8g --memory-swap=8g --pids-limit=2048 --cpus=4)
dev_args=(--rm "${DEV_CAPS[@]}" --network globnotes-test --hostname globnotes.test
    --workdir /workspace --entrypoint ''
    --volume "$source_dir:/workspace:rw" --volume "$run_dir/tmp:/run-tmp:rw"
    --volume "$run_dir/logs:/run-logs:rw"
    --volume "$run_dir/artifacts:/artifacts:rw"
    --env TMPDIR=/run-tmp --env DENO_DIR=/deno-dir --env GLOBNOTES_TEST_HOST=globnotes.test
    --env CDP_PORT=9335 --env NO_COLOR=1 --env VITEST_MAX_WORKERS=1)
if [[ "$backend" == podman ]]; then
    dev_args+=(--userns=keep-id:uid=1000,gid=1000 --user dev --volume globnotes-deno-cache:/deno-dir)
else
    # Docker runs as the invoking user, who owns neither the image's dev home nor
    # a new named volume (copied from the image as uid 1000): give it a cache
    # directory and a HOME it owns, with the image's default-cache link.
    cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/globnotes-run/deno-dir"
    mkdir -p "$cache_dir" "$run_dir/tmp/home/.cache" "$run_dir/tmp/chromium-home"
    ln -sfn /deno-dir "$run_dir/tmp/home/.cache/deno"
    dev_args+=(--user "$(id -u):$(id -g)" --volume "$cache_dir:/deno-dir:rw" --env HOME=/run-tmp/home)
fi
if ! "$browser"; then
    step workload workload.log
    timeout 3600 "$engine" run "${dev_args[@]}" "$dev_image" "$@" 2>&1 | tee "$step_log"
    exit 0
fi

name="globnotes-dev-$$-${RANDOM}"
chromium_name="${name/dev/chromium}"
# Attempt cleanup even when the engine creates a container but its run command fails.
dev_started=true
run_step start-dev-container dev.cid timeout 30 "$engine" run --detach --name "$name" "${dev_args[@]}" "$dev_image" sleep infinity
run_step inspect-dev-container inspect-dev.json timeout 15 "$engine" inspect "$name"
run_step dev-container-address dev-address.log timeout 15 "$engine" inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$name"
read -r dev_ip < "$step_log"
[[ -n "$dev_ip" && "$dev_ip" != 127.* ]] || fail 'dev container has no non-loopback address'
browser_args=(--detach --name "$chromium_name" --network "container:$name"
    --memory=2g --memory-swap=2g --pids-limit=512 --cpus=2 --shm-size=1g
    --volume "$run_dir/tmp:/run-tmp:rw" --env TMPDIR=/run-tmp)
if [[ "$backend" == podman ]]; then
    browser_args+=(--userns=keep-id:uid=1000,gid=1000 --user chromium)
else
    browser_args+=(--user "$(id -u):$(id -g)" --env HOME=/run-tmp/chromium-home)
fi
chromium_flags=()
if [[ "${GLOBNOTES_CHROMIUM_NO_SANDBOX:-0}" == 1 ]]; then
    chromium_flags+=(--no-sandbox)
fi
printf '%s\n' "no-sandbox=${GLOBNOTES_CHROMIUM_NO_SANDBOX:-0}" > "$run_dir/logs/sandbox.txt"
chromium_started=true
run_step start-chromium-container chromium.cid timeout 30 "$engine" run "${browser_args[@]}" "$chromium_image" "${chromium_flags[@]}" about:blank
run_step inspect-chromium-container inspect-chromium.json timeout 15 "$engine" inspect "$chromium_name"
run_step chromium-version chromium-version.txt timeout 15 "$engine" exec "$chromium_name" chromium --version
run_step resolve-dev-host getent-dev.txt timeout 15 "$engine" exec "$name" getent ahostsv4 globnotes.test
run_step resolve-chromium-host getent-chromium.txt timeout 15 "$engine" exec "$chromium_name" getent ahostsv4 globnotes.test
run_step chromium-cdp-readiness cdp-version.json timeout 32 "$engine" exec "$name" deno eval 'const end = Date.now() + 30000; while (true) { try { const r = await fetch("http://127.0.0.1:9335/json/version"); if (r.ok) { console.log(await r.text()); break; } } catch {} if (Date.now() >= end) { console.error("Chromium CDP endpoint did not become ready within 30 seconds"); Deno.exit(1); } await new Promise(r => setTimeout(r, 250)); }'
step workload workload.log
timeout 3600 "$engine" exec "$name" "$@" 2>&1 | tee "$step_log"
