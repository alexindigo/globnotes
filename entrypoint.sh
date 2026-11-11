#!/bin/sh
set -eu

# Resolve and validate before filesystem/ownership effects. Preserve operator env.
projection=$(deno run --cached-only --allow-read --allow-write --allow-env server/config/cli.ts --prepare-shell) || exit 1
eval "$projection"
EXEC_TOOL=${EXEC_TOOL:-su-exec}
if [ -z "${PUID:-}" ]; then
    PUID=$(stat -c %u "$LAUNCH_NOTES" 2>/dev/null || echo 1000)
    if [ "$PUID" = 0 ]; then PUID=1000; fi
fi
if [ -z "${PGID:-}" ]; then
    PGID=$(stat -c %g "$LAUNCH_NOTES" 2>/dev/null || echo 1000)
    if [ "$PGID" = 0 ]; then PGID=1000; fi
fi

if [ "$(id -u)" -eq 0 ] && [ "$(id -g)" -eq 0 ]; then
    # Mounted notes remain user-owned. Only resolved app metadata is prepared.
    notes_root=$(realpath "$LAUNCH_NOTES") || exit 1
    for directory in "$LAUNCH_INSTANCE_METADATA" "$LAUNCH_VAULT_METADATA"; do
        [ -d "$directory" ] || continue
        metadata_root=$(realpath "$directory") || exit 1
        case "$notes_root/" in
            "${metadata_root%/}/"*)
                echo "WARNING: metadata ownership skipped because it would include mounted notes" >&2
                continue ;;
        esac
        if ! chown -R "$PUID:$PGID" "$directory"; then
            echo "WARNING: could not own metadata directory (root-squashed mount?)" >&2
        fi
    done
    exec "$EXEC_TOOL" "$PUID:$PGID" deno run --unstable-worker-options --cached-only --allow-net --allow-read --allow-write --allow-env server/main.ts
fi
exec deno run --unstable-worker-options --cached-only --allow-net --allow-read --allow-write --allow-env server/main.ts
