#!/bin/sh

HOST="${GLOBNOTES_HOST:-0.0.0.0}"
case "$HOST" in
    0.0.0.0) HOST=127.0.0.1 ;;
    ::) HOST='[::1]' ;;
    *:*) HOST="[$HOST]" ;;
esac

# With GLOBNOTES_ALLOWED_HOSTS set, the server answers only the hosts it
# lists (421 otherwise), so ask by the first of them.
host_header=
if [ -n "$GLOBNOTES_ALLOWED_HOSTS" ]; then
    set -f
    old_ifs=$IFS
    IFS=,
    for entry in $GLOBNOTES_ALLOWED_HOSTS; do
        entry=$(printf '%s' "$entry" | tr -d '[:space:]')
        if [ -n "$entry" ]; then
            host_header=$entry
            break
        fi
    done
    IFS=$old_ifs
    set +f
fi

url="http://${HOST}:${GLOBNOTES_PORT:-8080}${GLOBNOTES_PATH_PREFIX}/_/api/health"
if [ -n "$host_header" ]; then
    wget -q -O /dev/null --header "Host: $host_header" "$url" || exit 1
else
    wget -q -O /dev/null "$url" || exit 1
fi
