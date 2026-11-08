#!/usr/bin/env bash
# Feature-owned real services. Project runtimes still use the unchanged launcher.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
run_dir=""
browser=()
while (($#)); do
    case "$1" in
        --browser) browser=(--browser); shift ;;
        --run-dir) run_dir="${2:?run directory required}"; shift 2 ;;
        --) shift; break ;;
        *) printf 'Unknown option: %s\n' "$1" >&2; exit 1 ;;
    esac
done
[[ -n "$run_dir" && $# -gt 0 ]] || { printf 'Use --run-dir DIR -- COMMAND\n' >&2; exit 1; }
[[ "$(timeout 10 hostname)" == ark ]] || { printf 'Run on ark\n' >&2; exit 1; }
[[ "${GLOBNOTES_CONTAINER_ENGINE:-podman}" == podman ]] || exit 1
[[ "$(timeout 20 podman info --format '{{.Host.Security.Rootless}}')" == true ]] || exit 1
run_dir="$(realpath -m -- "$run_dir")"
[[ "$run_dir" != /tmp && "$run_dir" != /tmp/* && ! -e "$run_dir" ]] || exit 1
[[ -d "$(dirname -- "$run_dir")" ]] || exit 1
mkdir "$run_dir"
mkdir "$run_dir/host-tmp" "$run_dir/services"
export TMPDIR="$run_dir/host-tmp" GLOBNOTES_CONTAINER_ENGINE=podman
token="rs-$$-$RANDOM"
s3="s3-$token"
dav="dav-$token"
# Resolved once, retained for reruns. SeaweedFS image revision ec8f979 (4.50).
s3_image=docker.io/chrislusf/seaweedfs@sha256:b2e51562743be5637381a82eeeee4872eb2f86994b723d25a1bbd171855fe18d
dav_image=docker.io/library/httpd@sha256:6afeed7af0b537d765bb2cfe4e98aade55139f2dd37dfc7b649756f8cd59a1c9
cleanup() {
    local status=$? cid owner exists_status
    trap - EXIT INT TERM
    for kind in s3 dav; do
        [[ -s "$run_dir/services/$kind.cid" ]] || continue
        cid="$(< "$run_dir/services/$kind.cid")"
        owner="$(timeout 15 podman inspect --format '{{index .Config.Labels "globnotes.remotely-save.owner"}}' "$cid")" || { status=1; continue; }
        [[ "$owner" == "$token" ]] || { status=1; continue; }
        timeout 15 podman inspect "$cid" > "$run_dir/services/$kind-final.json" || status=1
        timeout 20 podman stop --time 5 "$cid" > "$run_dir/services/$kind-stop.log" 2>&1 || status=1
        timeout 15 podman logs "$cid" > "$run_dir/services/$kind.log" 2>&1 || status=1
        timeout 20 podman rm "$cid" > "$run_dir/services/$kind-remove.log" 2>&1 || status=1
        exists_status=0
        timeout 15 podman container exists "$cid" || exists_status=$?
        if [[ "$exists_status" == 1 ]]; then
            printf '%s %s removed\n' "$kind" "$cid" >> "$run_dir/services/cleanup.txt"
        else
            status=1
            printf '%s %s absence check failed: %s\n' "$kind" "$cid" "$exists_status" >> "$run_dir/services/cleanup.txt"
        fi
    done
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
timeout 180 podman pull "$s3_image" > "$run_dir/services/s3-pull.log" 2>&1
timeout 180 podman pull "$dav_image" > "$run_dir/services/dav-pull.log" 2>&1
timeout 20 podman image inspect "$s3_image" "$dav_image" > "$run_dir/services/images.json"
# Same network creation convention as run.sh; never reconfigure an existing one.
timeout 15 podman network exists globnotes-test || timeout 20 podman network create globnotes-test
timeout 180 "$ROOT/.devcontainer/run.sh" --run-dir "$run_dir/bootstrap" -- \
    timeout 90 deno run --allow-read --allow-write tests/interop/prepare_services.ts
mkdir -p "$run_dir/workload/artifacts"
cp -a "$run_dir/bootstrap/artifacts/services" "$run_dir/workload/artifacts/services"
services="$run_dir/workload/artifacts/services"
caps=(--memory=1g --memory-swap=1g --pids-limit=128 --cpus=1)
common=("${caps[@]}" --network globnotes-test --label "globnotes.remotely-save.owner=$token"
    --userns=keep-id:uid=1000,gid=1000 --user 1000:1000 --env TMPDIR=/services/tmp
    --volume "$services:/services:rw" --volume "$services/tmp:/tmp:rw")
timeout 30 podman run --detach --cidfile "$run_dir/services/s3.cid" --name "$s3" \
    "${common[@]}" --network-alias "$s3" --network-alias "bucket.$s3" \
    --volume "$services/s3:/data:rw" --entrypoint /bin/sh "$s3_image" \
    -c 'exec weed "$@" > /services/s3/requests.log 2>&1' sh \
    -logtostderr=true -v=2 -logdir=/services/s3/logs mini -dir=/data -ip=127.0.0.1 -ip.bind=0.0.0.0 \
    -s3.domainName="$s3" -s3.config=/services/s3.json -s3.autoCreateBucket=false \
    -filer.localSocket=/services/s3/filer.sock -s3.localSocket=/services/s3/s3.sock \
    -volume.max=8 -master.volumeSizeLimitMB=64 -master.telemetry=false \
    -webdav=false -admin.ui=false -s3.port.iceberg=0 -s3.port.lance=0
timeout 30 podman run --detach --cidfile "$run_dir/services/dav.cid" --name "$dav" \
    "${common[@]}" --network-alias "$dav" --entrypoint httpd "$dav_image" \
    -f /services/httpd.conf -DFOREGROUND
for kind in s3 dav; do
    cid="$(< "$run_dir/services/$kind.cid")"
    timeout 15 podman inspect "$cid" > "$run_dir/services/$kind-start.json"
done
timeout 1800 "$ROOT/.devcontainer/run.sh" "${browser[@]}" --run-dir "$run_dir/workload" -- \
    env RS_S3_ENDPOINT="http://$s3:8333" RS_DAV_ENDPOINT="http://$dav:8080" \
    RS_RUN_BROWSER="${#browser[@]}" \
    timeout 1500 bash tests/interop/remotely_save_workload.sh "$@"
