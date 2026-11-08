#!/usr/bin/env bash
# Reuse only exact-SHA successful PR test evidence; uncertainty runs the tests.
set -euo pipefail

find_proof() {
    [[ "${GITHUB_EVENT_NAME:-}" == push && "${GITHUB_REF:-}" =~ ^refs/heads/(main|v2)$ ]] || return 1
    [[ "${GITHUB_SHA:-}" =~ ^[0-9a-f]{40}$ && "${GITHUB_REPOSITORY:-}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || return 1
    local branch="${GITHUB_REF#refs/heads/}"
    local runs prs id url sha event status conclusion run_repo relation jobs
    local pr_number base_ref base_sha pr_head base_repo head_repo
    local job_id job_name job_status job_conclusion
    runs="$(timeout 45s gh api --paginate \
        "repos/$GITHUB_REPOSITORY/actions/workflows/ci.yml/runs?event=pull_request&status=success&head_sha=$GITHUB_SHA&per_page=100" \
        --jq '.workflow_runs[] | [.id, .html_url, .head_sha, .event, .status, .conclusion, .head_repository.full_name] | @tsv')" || return 1
    [[ -n "$runs" ]] || return 1
    # Workflow-run PR associations can disappear after merge. The commit lookup
    # retains merged PRs; bind their exact head and repository to the run below.
    prs="$(timeout 45s gh api --paginate \
        "repos/$GITHUB_REPOSITORY/commits/$GITHUB_SHA/pulls?per_page=100" \
        --jq '.[] | [.number, .base.ref, .base.sha, .head.sha, .base.repo.full_name, .head.repo.full_name] | @tsv')" || return 1
    while IFS=$'\t' read -r id url sha event status conclusion run_repo; do
        [[ -n "$id" ]] || continue
        [[ "$id" =~ ^[0-9]+$ && "$url" == "https://github.com/$GITHUB_REPOSITORY/actions/runs/$id" ]] || return 1
        [[ "$sha" == "$GITHUB_SHA" && "$event" == pull_request && "$status" == completed && "$conclusion" == success && "$run_repo" == "$GITHUB_REPOSITORY" ]] || continue
        while IFS=$'\t' read -r pr_number base_ref base_sha pr_head base_repo head_repo; do
            [[ -n "$pr_number" ]] || continue
            [[ "$pr_number" =~ ^[1-9][0-9]*$ ]] || return 1
            # A repository may itself be a fork: reject cross-repository PRs,
            # not that provenance flag. Missing/unknown identities fail closed.
            [[ "$pr_head" == "$sha" && "$base_ref" == "$branch" && "$base_repo" == "$GITHUB_REPOSITORY" && "$head_repo" == "$run_repo" ]] || continue
            [[ "$base_sha" =~ ^[0-9a-f]{40}$ ]] || return 1
            # The reported base must be an ancestor of the head. Merge-tree
            # equivalence also relies on this repo's FF-only branch updates;
            # run metadata identifies the head, not the tested merge SHA.
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
        done <<< "$prs"
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
