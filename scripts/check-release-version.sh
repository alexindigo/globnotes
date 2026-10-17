#!/usr/bin/env bash
# Release tags must equal "v" + the tracked VERSION (docs/releasing.md).
# Usage: check-release-version.sh <tag>   Exit 0 only on a match.
set -euo pipefail
if [ "$#" -ne 1 ]; then
  echo "usage: $0 <tag>" >&2
  exit 1
fi
tag="$1"
version_file="$(cd "$(dirname "$0")/.." && pwd)/VERSION"
version=""
read -r version < "$version_file" || true
if [ -n "$version" ] && [ "$tag" = "v$version" ]; then
  echo "Release tag $tag matches VERSION $version"
  exit 0
fi
echo "Release tag $tag does not match VERSION $version (expected v$version)" >&2
exit 1
