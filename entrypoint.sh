#!/bin/sh

[ "$EXEC_TOOL" ] || EXEC_TOOL=gosu
[ "$GLOBNOTES_HOST" ] || GLOBNOTES_HOST=0.0.0.0
[ "$GLOBNOTES_PORT" ] || GLOBNOTES_PORT=8080

set -e

echo "\
======================================
======== Welcome to globnotes ========
======================================

A fork of flatnotes by Adam Dullage,
where a note's title is its path.

──────────────────────────────────────
"

globnotes_command="python -m \
                  uvicorn \
                  main:app \
                  --app-dir server \
                  --host ${GLOBNOTES_HOST} \
                  --port ${GLOBNOTES_PORT} \
                  --proxy-headers \
                  --forwarded-allow-ips '*'"

if [ `id -u` -eq 0 ] && [ `id -g` -eq 0 ]; then
    echo Setting file permissions...
    chown -R ${PUID}:${PGID} ${GLOBNOTES_PATH}

    echo Starting globnotes as user ${PUID}...
    exec ${EXEC_TOOL} ${PUID}:${PGID} ${globnotes_command}

else
    echo "A user was set by docker, skipping file permission changes."
    echo Starting globnotes as user $(id -u)...
    exec ${globnotes_command}
fi
