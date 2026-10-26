#!/usr/bin/env bash
# Only releases in the highest released major may publish Docker's latest tag.
# Usage: docker-latest-tag.sh <tag>   Prints true/false and sets the latest output.
set -euo pipefail
if [ "$#" -ne 1 ]; then
  echo "usage: $0 <tag>" >&2
  exit 1
fi
tag="$1"
release_pattern='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
if [[ ! "$tag" =~ $release_pattern ]]; then
  echo "Release tag $tag must have the form vX.Y.Z (no prerelease or build suffix)" >&2
  exit 1
fi
major="${BASH_REMATCH[1]}"
# The checkout must fetch all tags. Filter before sorting so preview, historical
# two-part and other non-release tags cannot reserve a major. Numeric sort also
# handles multi-digit majors without shell-integer overflow.
tags="$(git tag --list)"
highest_major="$(
  while IFS= read -r candidate; do
    if [[ "$candidate" =~ $release_pattern ]]; then
      printf '%s\n' "${BASH_REMATCH[1]}"
    fi
  done <<< "$tags" | sort -n | tail -n 1
)"
if [ -z "$highest_major" ]; then
  echo "No release tags of the form vX.Y.Z found; fetch repository tags first" >&2
  exit 1
fi
latest=false
if [ "$major" = "$highest_major" ]; then
  latest=true
fi
echo "Release tag $tag: latest=$latest (highest released major: $highest_major)" >&2
echo "$latest"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "latest=$latest" >> "$GITHUB_OUTPUT"
fi
