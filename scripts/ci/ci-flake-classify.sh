#!/usr/bin/env bash
set -euo pipefail

# ci-flake-classify.sh — classify a PR's failing CI checks as GitHub-infra flake vs genuine.
#
# Usage:
#   scripts/ci/ci-flake-classify.sh <PR-number> [--rerun]
#
# Default is classify-only (read-only): prints a verdict and which jobs are infra vs genuine.
# --rerun is opt-in and ONLY re-runs failed jobs when EVERY failure is an infra flake (never
# when a genuine failure is present). Re-running CI is idempotent and touches no prod/staging.
#
# Auth surface: the local `gh` CLI only. This script never reads JWTs or service tokens, and
# never puts a secret on a command line.
#
# Exit codes (chainable into a bounded-retry loop):
#   0  no failing checks (all clear)
#   2  all failures are infra flakes (safe to rerun)
#   3  at least one genuine failure (do NOT rerun blindly — investigate)
#   1  script/usage error (bad args, gh unavailable)
#
# Infra-flake signatures — observed in real GitHub Actions incidents (2026-05-26, PR #1876).
# EVERY signature is CONTEXT-BOUND: a bare token like "HTTP 403" or "exit code 128" is NOT a
# signature, because genuine app/auth/permission tests legitimately print those. Each pattern
# ties the failure to a GitHub-infra context (action download or git checkout):
#   action-CDN download (Set up job): pnpm/action-setup, codeload.github.com,
#     "Download action repository", "could not be found at the URI", "Failed to download archive"
#   repo checkout / git transport (Checkout repository): "unable to access 'https://…github"
#     (URL-bound 403/auth), "RPC failed; HTTP" (git RPC), "/usr/bin/git' failed with exit code 128"
#     (git-bound 128), "fatal: expected 'packfile'" (git clone)
# A failure whose log matches none of these is classified GENUINE (fail-safe: unknown → real,
# never silently rerun). In particular a bare app-level "HTTP 403" stays GENUINE.
INFRA_SIGNATURES='pnpm/action-setup|codeload\.github\.com|Download action repository|could not be found at the URI|Failed to download archive|unable to access .https?://[^ ]*github|RPC failed; HTTP|/usr/bin/git. failed with exit code 128|fatal: expected .packfile'

# is_infra_log <text> | echo <text> | is_infra_log
# Returns 0 if the log text matches a known infra signature, 1 otherwise.
is_infra_log() {
  local text="${1:-$(cat)}"
  grep -qiE "$INFRA_SIGNATURES" <<<"$text"
}

_die() { echo "ci-flake-classify: $*" >&2; exit 1; }

classify_pr() {
  local pr="$1" do_rerun="$2"
  command -v gh >/dev/null 2>&1 || _die "gh CLI not found"
  [[ "$pr" =~ ^[0-9]+$ ]] || _die "PR number must be numeric, got: $pr"

  # tab-separated: name<TAB>state<TAB>elapsed<TAB>url
  local checks; checks="$(gh pr checks "$pr" 2>/dev/null)" || _die "could not read checks for PR #$pr"
  local failing; failing="$(awk -F'\t' '$2=="fail"{print $1"\t"$NF}' <<<"$checks")"

  if [[ -z "$failing" ]]; then
    echo "VERDICT: CLEAR — no failing checks on PR #$pr"
    return 0
  fi

  local genuine="" infra="" run_ids=""
  while IFS=$'\t' read -r name url; do
    [[ -z "$name" ]] && continue
    local job_id run_id log
    job_id="$(grep -oE 'job/[0-9]+' <<<"$url" | grep -oE '[0-9]+' || true)"
    run_id="$(grep -oE 'runs/[0-9]+' <<<"$url" | grep -oE '[0-9]+' || true)"
    [[ -n "$run_id" ]] && run_ids+="$run_id"$'\n'
    log=""
    [[ -n "$job_id" ]] && log="$(gh run view --job "$job_id" --log-failed 2>/dev/null | tail -50 || true)"
    if [[ -n "$log" ]] && is_infra_log "$log"; then
      infra+="  [infra]   $name"$'\n'
    else
      genuine+="  [genuine] $name"$'\n'
    fi
  done <<<"$failing"

  echo "Failing checks on PR #$pr:"
  [[ -n "$infra" ]]   && printf '%s' "$infra"
  [[ -n "$genuine" ]] && printf '%s' "$genuine"

  if [[ -n "$genuine" ]]; then
    echo "VERDICT: GENUINE — at least one failure is not an infra flake; do NOT rerun blindly."
    return 3
  fi

  echo "VERDICT: INFRA — all failures match known GitHub-infra signatures (safe to rerun)."
  if [[ "$do_rerun" == "true" ]]; then
    local uniq_runs; uniq_runs="$(printf '%s' "$run_ids" | sort -u | grep -E '^[0-9]+$' || true)"
    for r in $uniq_runs; do
      echo "  rerunning failed jobs in run $r"
      gh run rerun "$r" --failed >/dev/null 2>&1 || echo "  (rerun $r failed to dispatch)" >&2
    done
  else
    echo "  (re-run with: $0 $pr --rerun)"
  fi
  return 2
}

main() {
  local pr="${1:-}" flag="${2:-}"
  [[ -z "$pr" || "$pr" == "-h" || "$pr" == "--help" ]] && _die "usage: $0 <PR-number> [--rerun]"
  local do_rerun="false"
  [[ "$flag" == "--rerun" ]] && do_rerun="true"
  classify_pr "$pr" "$do_rerun"
}

# Allow sourcing (for tests) without executing main.
if [[ "${BASH_SOURCE[0]:-$0}" == "${0}" ]]; then
  main "$@"
fi
