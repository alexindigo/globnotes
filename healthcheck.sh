#!/bin/sh
set -eu
projection=$(deno run --cached-only --allow-read --allow-env server/config/cli.ts --shell) || exit 1
eval "$projection"
HOST=$LAUNCH_HOST
case "$HOST" in
    0.0.0.0) HOST=127.0.0.1 ;;
    ::) HOST='[::1]' ;;
    *:*) HOST="[$HOST]" ;;
esac
url="http://${HOST}:${LAUNCH_PORT}${LAUNCH_PREFIX}/_/api/health"
if [ -n "$LAUNCH_HEALTH_HOST" ]; then
    wget -q -O /dev/null --header "Host: $LAUNCH_HEALTH_HOST" "$url" || exit 1
else
    wget -q -O /dev/null "$url" || exit 1
fi
