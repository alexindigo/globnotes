#!/usr/bin/env bash
# Runs only inside the unchanged dev launcher, after the real services exist.
set -euo pipefail
timeout 1200 "$@"
if [[ "${RS_RUN_BROWSER:-0}" == 1 ]]; then
    timeout 120 deno task build:client > /run-logs/native-build.log 2>&1
    timeout 360 env RS_NATIVE_REAL=1 GLOBNOTES_E2E_CASES=remotely-save-native-s3-none,remotely-save-native-s3-openssl-base64,remotely-save-native-s3-rclone-base64,remotely-save-native-webdav-none,remotely-save-native-webdav-openssl-base64,remotely-save-native-webdav-rclone-base64 \
        GLOBNOTES_E2E_ARTIFACTS=/artifacts/native-real \
        bash client/tests/e2e/run.sh
fi
