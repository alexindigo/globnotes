#!/bin/sh

curl -f http://localhost:${GLOBNOTES_PORT}${GLOBNOTES_PATH_PREFIX}/_/api/health || exit 1
