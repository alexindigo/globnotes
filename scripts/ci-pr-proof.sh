#!/usr/bin/env bash
# Reuse only exact-SHA successful PR test evidence; uncertainty runs the tests.
set -euo pipefail

find_proof() {
    [[ "${GITHUB_EVENT_NAME:-}" == push && "${GITHUB_REF:-}" =~ ^refs/heads/(main|v2)$ ]] || return 1
    [[ "${GITHUB_SHA:-}" =~ ^[0-9a-f]{40}$ && "${GITHUB_REPOSITORY:-}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || return 1
    local branch="${GITHUB_REF#refs/heads/}"
    local runs id url sha event status conclusion base_ref base_sha pr_head relation jobs
    local job_id job_name job_status job_conclusion
    runs="$(timeout 45s gh api --paginate \
        "repos/$GITHUB_REPOSITORY/actions/workflows/ci.yml/runs?event=pull_request&status=success&head_sha=$GITHUB_SHA&per_page=100" \
        --jq '.workflow_runs[] | . as $run | .pull_requests[]? | [$run.id, $run.html_url, $run.head_sha, $run.event, $run.status, $run.conclusion, .base.ref, .base.sha, .head.sha] | @tsv')" || return 1
    # An empty PR association (including fork runs) produces no eligible rows.
    while IFS=$'\t' read -r id url sha event status conclusion base_ref base_sha pr_head; do
        [[ -n "$id" ]] || continue
        [[ "$id" =~ ^[0-9]+$ && "$url" == "https://github.com/$GITHUB_REPOSITORY/actions/runs/$id" ]] || return 1
        [[ "$sha" == "$GITHUB_SHA" && "$pr_head" == "$GITHUB_SHA" && "$event" == pull_request && "$status" == completed && "$conclusion" == success && "$base_ref" == "$branch" ]] || continue
        [[ "$base_sha" =~ ^[0-9a-f]{40}$ ]] || return 1
        # The recorded base must be an ancestor of the head. Merge-tree
        # equivalence additionally relies on this repo's FF-only branch updates;
        # run/check-suite metadata identifies the head, not the tested merge SHA.
        relation="$(timeout 45s gh api \
            "repos/$GITHUB_REPOSITORY/compare/$base_sha...$GITHUB_SHA" --jq '.status')" || return 1
        case "$relation" in
            ahead|identical) ;;
            behind|diverged) continue ;;
            *) return 1 ;;
        esac
        jobs="$(timeout 45s gh api --paginate \
            "repos/$GITHUB_REPOSITORY/actions/runs/$id/jobs?filter=latest&per_page=100" \
            --jq '.jobs[] | [.id, .name, .status, .conclusion] | @tsv')" || return 1
        while IFS=$'\t' read -r job_id job_name job_status job_conclusion; do
            [[ -n "$job_id" ]] || continue
            [[ "$job_id" =~ ^[0-9]+$ ]] || return 1
            if [[ "$job_name" == test && "$job_status" == completed && "$job_conclusion" == success ]]; then
                printf '%s\n' "$url"
                return 0
            fi
        done <<< "$jobs"
    done <<< "$runs"
    return 1
}

run_tests=true
if proof="$(find_proof)"; then
    run_tests=false
    note="Exact head SHA $GITHUB_SHA already passed the PR test job targeting ${GITHUB_REF#refs/heads/}: $proof . Reusing that successful evidence."
else
    note="Running tests: no verified exact-SHA successful PR test evidence (or lookup unavailable)."
fi
printf '%s\n' "$note"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then printf 'run-tests=%s\n' "$run_tests" >> "$GITHUB_OUTPUT"; fi
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then printf '%s\n' "$note" >> "$GITHUB_STEP_SUMMARY"; fi
