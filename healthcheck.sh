#!/bin/sh

wget -q -O /dev/null "http://localhost:${GLOBNOTES_PORT:-8080}${GLOBNOTES_PATH_PREFIX}/_/api/health" || exit 1
