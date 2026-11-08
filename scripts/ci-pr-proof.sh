#!/usr/bin/env bash
# Reuse only exact-SHA successful PR test evidence; uncertainty runs the tests.
set -euo pipefail

find_proof() {
    [[ "${GITHUB_EVENT_NAME:-}" == push && "${GITHUB_REF:-}" =~ ^refs/heads/(main|v2)$ ]] || return 1
    [[ "${GITHUB_SHA:-}" =~ ^[0-9a-f]{40}$ && "${GITHUB_REPOSITORY:-}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || return 1
    local runs id url jobs
    runs="$(timeout 45s gh api --paginate \
        "repos/$GITHUB_REPOSITORY/actions/workflows/ci.yml/runs?event=pull_request&status=success&head_sha=$GITHUB_SHA&per_page=100" \
        --jq ".workflow_runs[] | select(.head_sha == \"$GITHUB_SHA\" and .event == \"pull_request\" and .status == \"completed\" and .conclusion == \"success\") | [.id, .html_url] | @tsv")" || return 1
    while IFS=$'\t' read -r id url; do
        [[ -n "$id" ]] || continue
        [[ "$id" =~ ^[0-9]+$ && "$url" == "https://github.com/$GITHUB_REPOSITORY/actions/runs/$id" ]] || return 1
        jobs="$(timeout 45s gh api --paginate \
            "repos/$GITHUB_REPOSITORY/actions/runs/$id/jobs?filter=latest&per_page=100" \
            --jq '.jobs[] | select(.name == "test" and .status == "completed" and .conclusion == "success") | .id')" || return 1
        if [[ "$jobs" =~ ^[0-9]+$ ]]; then
            printf '%s\n' "$url"
            return 0
        fi
    done <<< "$runs"
    return 1
}

run_tests=true
if proof="$(find_proof)"; then
    run_tests=false
    note="Exact head SHA $GITHUB_SHA already passed the PR test job: $proof . Reusing that successful evidence."
else
    note="Running tests: no verified exact-SHA successful PR test evidence (or lookup unavailable)."
fi
printf '%s\n' "$note"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then printf 'run-tests=%s\n' "$run_tests" >> "$GITHUB_OUTPUT"; fi
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then printf '%s\n' "$note" >> "$GITHUB_STEP_SUMMARY"; fi
