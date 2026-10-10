#!/bin/sh

HOST="${GLOBNOTES_HOST:-0.0.0.0}"
case "$HOST" in
    0.0.0.0) HOST=127.0.0.1 ;;
    ::) HOST='[::1]' ;;
    *:*) HOST="[$HOST]" ;;
esac

wget -q -O /dev/null "http://${HOST}:${GLOBNOTES_PORT:-8080}${GLOBNOTES_PATH_PREFIX}/_/api/health" || exit 1
