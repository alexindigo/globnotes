#!/bin/sh

[ "$EXEC_TOOL" ] || EXEC_TOOL=su-exec
[ "$GLOBNOTES_HOST" ] || GLOBNOTES_HOST=0.0.0.0
[ "$GLOBNOTES_PORT" ] || GLOBNOTES_PORT=8080
[ "$GLOBNOTES_PATH" ] || GLOBNOTES_PATH=/data

# Ownership follows the vault owner; explicit PUID/PGID always wins.
# A root-owned vault (stat yields 0) falls back to the historical 1000.
if [ -z "$PUID" ]; then
    PUID=$(stat -c %u "$GLOBNOTES_PATH" 2>/dev/null || echo 1000)
    if [ "$PUID" = "0" ]; then PUID=1000; fi
fi
if [ -z "$PGID" ]; then
    PGID=$(stat -c %g "$GLOBNOTES_PATH" 2>/dev/null || echo 1000)
    if [ "$PGID" = "0" ]; then PGID=1000; fi
fi

set -e

echo "\
======================================
======== Welcome to globnotes ========
======================================

A fork of flatnotes by Adam Dullage,
where a note's title is its path.

──────────────────────────────────────
"

globnotes_command="deno run \
                  --unstable-worker-options \
                  --cached-only \
                  --allow-net \
                  --allow-read \
                  --allow-write \
                  --allow-env \
                  server/main.ts"

if [ `id -u` -eq 0 ] && [ `id -g` -eq 0 ]; then
    echo Preparing the index/config directory...
    # Only the app's own state dir needs to be owned by the app user.
    # Mounted vault content is never chowned — it belongs to the user.
    STATE_DIR="${GLOBNOTES_INDEX_PATH:-${GLOBNOTES_PATH}/.globnotes}"
    mkdir -p "${STATE_DIR}"
    # Root-squashed NFS/CIFS vaults can refuse the chown — warn, don't abort.
    if ! chown -R ${PUID}:${PGID} "${STATE_DIR}"; then
        echo "WARNING: could not own ${STATE_DIR} (root-squashed mount?) — continuing" >&2
    fi

    echo Starting globnotes as user ${PUID}...
    exec ${EXEC_TOOL} ${PUID}:${PGID} ${globnotes_command}

else
    echo "A user was set by docker, skipping file permission changes."
    echo Starting globnotes as user $(id -u)...
    exec ${globnotes_command}
fi
