#!/bin/sh

curl -f http://localhost:${GLOBNOTES_PORT}${GLOBNOTES_PATH_PREFIX}/health || exit 1
