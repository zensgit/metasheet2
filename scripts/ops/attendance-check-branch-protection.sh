#!/usr/bin/env bash
set -euo pipefail

REPO="${REPO:-${GITHUB_REPOSITORY:-zensgit/metasheet2}}"
BRANCH="${BRANCH:-main}"
REQUIRED_CHECKS_CSV="${REQUIRED_CHECKS_CSV:-contracts (strict),contracts (dashboard)}"
REQUIRE_STRICT="${REQUIRE_STRICT:-true}"
REQUIRE_ENFORCE_ADMINS="${REQUIRE_ENFORCE_ADMINS:-false}"
REQUIRE_PR_REVIEWS="${REQUIRE_PR_REVIEWS:-false}"
MIN_APPROVING_REVIEW_COUNT="${MIN_APPROVING_REVIEW_COUNT:-1}"
REQUIRE_CODE_OWNER_REVIEWS="${REQUIRE_CODE_OWNER_REVIEWS:-false}"
OUTPUT_JSON="${OUTPUT_JSON:-}"

function die() {
  local reason="$1"
  local message="$2"
  echo "[attendance-check-branch-protection] reason=${reason}" >&2
  echo "[attendance-check-branch-protection] ERROR: ${message}" >&2
  exit 1
}

function info() {
  echo "[attendance-check-branch-protection] $*" >&2
}

function trim() {
  printf '%s' "$1" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g'
}

function bool_normalize() {
  local value
  value="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  case "$value" in
    1|true|yes|on) echo "true" ;;
    *) echo "false" ;;
  esac
}

command -v gh >/dev/null 2>&1 || die "DEPENDENCY_MISSING" "gh is required"
command -v jq >/dev/null 2>&1 || die "DEPENDENCY_MISSING" "jq is required"

if [[ "$REPO" != */* ]]; then
  die "INVALID_REPO" "REPO must be owner/name (got: $REPO)"
fi
owner="${REPO%%/*}"
repo_name="${REPO##*/}"

require_strict="$(bool_normalize "$REQUIRE_STRICT")"
require_enforce_admins="$(bool_normalize "$REQUIRE_ENFORCE_ADMINS")"
require_pr_reviews="$(bool_normalize "$REQUIRE_PR_REVIEWS")"
require_code_owner_reviews="$(bool_normalize "$REQUIRE_CODE_OWNER_REVIEWS")"
if [[ ! "$MIN_APPROVING_REVIEW_COUNT" =~ ^[0-9]+$ ]]; then
  die "INVALID_MIN_APPROVING_REVIEW_COUNT" "MIN_APPROVING_REVIEW_COUNT must be a non-negative integer"
fi
min_approving_review_count="$MIN_APPROVING_REVIEW_COUNT"

required_checks=()
IFS=',' read -r -a raw_required_checks <<< "$REQUIRED_CHECKS_CSV"
for raw in "${raw_required_checks[@]}"; do
  value="$(trim "$raw")"
  [[ -n "$value" ]] || continue
  required_checks+=("$value")
done
if (( ${#required_checks[@]} == 0 )); then
  die "INVALID_REQUIRED_CHECKS" "no required checks configured from REQUIRED_CHECKS_CSV"
fi

info "repo=${REPO} branch=${BRANCH}"
info "required_checks=$(IFS=,; echo "${required_checks[*]}") require_strict=${require_strict} require_enforce_admins=${require_enforce_admins} require_pr_reviews=${require_pr_reviews} min_approving_review_count=${min_approving_review_count} require_code_owner_reviews=${require_code_owner_reviews}"

tmp_dir="$(mktemp -d)"
cleanup() { rm -rf "$tmp_dir"; }
trap cleanup EXIT

protection_json="${tmp_dir}/protection.json"
protection_err="${tmp_dir}/protection.err"
graphql_json="${tmp_dir}/graphql.json"
graphql_err="${tmp_dir}/graphql.err"

strict_current=""
enforce_admins_current=""
pr_reviews_required_current=""
approving_review_count_current=""
code_owner_reviews_current=""
contexts_current=()

function try_graphql_fallback() {
  set +e
  gh api graphql \
    -f query='query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){ branchProtectionRules(first:100){ nodes{ pattern requiresStrictStatusChecks isAdminEnforced requiredStatusCheckContexts requiresApprovingReviews requiredApprovingReviewCount requiresCodeOwnerReviews } } } }' \
    -f owner="$owner" \
    -f name="$repo_name" \
    >"$graphql_json" 2>"$graphql_err"
  local gql_rc=$?
  set -e
  if (( gql_rc != 0 )); then
    return 1
  fi

  local lines_path="${tmp_dir}/graphql-rules.tsv"
  jq -r '
    .data.repository.branchProtectionRules.nodes[]? |
    [
      .pattern,
      ((.requiresStrictStatusChecks // false) | tostring),
      ((.isAdminEnforced // false) | tostring),
      ((.requiresApprovingReviews // false) | tostring),
      ((.requiredApprovingReviewCount // 0) | tostring),
      ((.requiresCodeOwnerReviews // false) | tostring),
      ((.requiredStatusCheckContexts // []) | join("\u001f"))
    ] |
    @tsv
  ' "$graphql_json" >"$lines_path"

  local best_score=-1
  local best_pattern=""
  local best_strict=""
  local best_enforce_admins=""
  local best_pr_reviews_required=""
  local best_approving_review_count=""
  local best_code_owner_reviews=""
  local best_contexts_join=""

  while IFS=$'\t' read -r pattern strict_value enforce_admins_value pr_reviews_required_value approving_review_count_value code_owner_reviews_value contexts_join; do
    [[ -n "${pattern:-}" ]] || continue
    local match=false
    local score=-1

    if [[ "$pattern" == "$BRANCH" ]]; then
      match=true
      score=$((1000 + ${#pattern}))
    elif [[ "$BRANCH" == $pattern ]]; then
      match=true
      score=${#pattern}
    fi

    if [[ "$match" == "true" && "$score" -gt "$best_score" ]]; then
      best_score="$score"
      best_pattern="$pattern"
      best_strict="$strict_value"
      best_enforce_admins="$enforce_admins_value"
      best_pr_reviews_required="$pr_reviews_required_value"
      best_approving_review_count="$approving_review_count_value"
      best_code_owner_reviews="$code_owner_reviews_value"
      best_contexts_join="$contexts_join"
    fi
  done <"$lines_path"

  if [[ "$best_score" -lt 0 ]]; then
    return 2
  fi

  strict_current="${best_strict:-false}"
  enforce_admins_current="${best_enforce_admins:-false}"
  pr_reviews_required_current="${best_pr_reviews_required:-false}"
  approving_review_count_current="${best_approving_review_count:-0}"
  code_owner_reviews_current="${best_code_owner_reviews:-false}"
  contexts_current=()
  if [[ -n "${best_contexts_join:-}" ]]; then
    IFS=$'\x1f' read -r -a contexts_current <<< "$best_contexts_join"
  fi
  info "graphql_fallback_pattern=${best_pattern}"
  return 0
}

set +e
gh api -H "Accept: application/vnd.github+json" \
  "/repos/${owner}/${repo_name}/branches/${BRANCH}/protection" \
  >"$protection_json" 2>"$protection_err"
rc=$?
set -e

if (( rc != 0 )); then
  err_text="$(cat "$protection_err" 2>/dev/null || true)"
  if grep -qi "Branch not protected" <<<"$err_text"; then
    die "BRANCH_NOT_PROTECTED" "branch '${BRANCH}' is not protected"
  fi
  if grep -Eqi "Resource not accessible by integration|HTTP 403" <<<"$err_text"; then
    if try_graphql_fallback; then
      info "using_graphql_fallback=true"
    else
      gql_fallback_rc=$?
      if (( gql_fallback_rc == 2 )); then
        die "BRANCH_NOT_PROTECTED" "branch '${BRANCH}' is not protected"
      fi
      gql_err="$(cat "$graphql_err" 2>/dev/null || true)"
      die "API_FORBIDDEN" "branch protection API is forbidden and graphql fallback failed: ${gql_err:-unknown error}"
    fi
  else
    die "API_FAILED" "failed to fetch branch protection: ${err_text:-unknown error}"
  fi
else
  strict_current="$(jq -r '.required_status_checks.strict // false' "$protection_json")"
  enforce_admins_current="$(jq -r '.enforce_admins.enabled // false' "$protection_json")"
  pr_reviews_required_current="$(jq -r 'if (.required_pull_request_reviews == null) then false else true end' "$protection_json")"
  approving_review_count_current="$(jq -r '.required_pull_request_reviews.required_approving_review_count // 0' "$protection_json")"
  code_owner_reviews_current="$(jq -r '.required_pull_request_reviews.require_code_owner_reviews // false' "$protection_json")"
  mapfile -t contexts_current < <(jq -r '.required_status_checks.contexts[]? // empty' "$protection_json")
fi

missing_checks=()
for check in "${required_checks[@]}"; do
  found=false
  for current in "${contexts_current[@]}"; do
    if [[ "$current" == "$check" ]]; then
      found=true
      break
    fi
  done
  if [[ "$found" == "false" ]]; then
    missing_checks+=("$check")
  fi
done

if [[ ! "$approving_review_count_current" =~ ^[0-9]+$ ]]; then
  approving_review_count_current=0
fi
checks_missing_csv=""
if (( ${#missing_checks[@]} > 0 )); then
  checks_missing_csv="$(IFS=,; echo "${missing_checks[*]}")"
fi

strict_ok=true
if [[ "$require_strict" == "true" && "$strict_current" != "true" ]]; then
  strict_ok=false
fi

admins_ok=true
if [[ "$require_enforce_admins" == "true" && "$enforce_admins_current" != "true" ]]; then
  admins_ok=false
fi

checks_ok=true
if (( ${#missing_checks[@]} > 0 )); then
  checks_ok=false
fi

pr_reviews_enabled_ok=true
if [[ "$require_pr_reviews" == "true" && "$pr_reviews_required_current" != "true" ]]; then
  pr_reviews_enabled_ok=false
fi

approving_count_ok=true
if [[ "$require_pr_reviews" == "true" && "$approving_review_count_current" -lt "$min_approving_review_count" ]]; then
  approving_count_ok=false
fi

code_owner_ok=true
if [[ "$require_code_owner_reviews" == "true" && "$code_owner_reviews_current" != "true" ]]; then
  code_owner_ok=false
fi

info "strict_current=${strict_current}"
info "enforce_admins_current=${enforce_admins_current}"
info "pr_reviews_required_current=${pr_reviews_required_current}"
info "approving_review_count_current=${approving_review_count_current}"
info "code_owner_reviews_current=${code_owner_reviews_current}"
info "checks_missing=${checks_missing_csv}"
info "contexts_current=$(IFS=,; echo "${contexts_current[*]}")"

if [[ -n "$OUTPUT_JSON" ]]; then
  mkdir -p "$(dirname "$OUTPUT_JSON")"
  jq -n \
    --arg repo "$REPO" \
    --arg branch "$BRANCH" \
    --arg requireStrict "$require_strict" \
    --arg strictCurrent "$strict_current" \
    --arg requireEnforceAdmins "$require_enforce_admins" \
    --arg enforceAdminsCurrent "$enforce_admins_current" \
    --arg requirePrReviews "$require_pr_reviews" \
    --arg minApprovingReviewCount "$min_approving_review_count" \
    --arg prReviewsRequiredCurrent "$pr_reviews_required_current" \
    --arg approvingReviewCountCurrent "$approving_review_count_current" \
    --arg requireCodeOwnerReviews "$require_code_owner_reviews" \
    --arg codeOwnerReviewsCurrent "$code_owner_reviews_current" \
    --arg strictOk "$strict_ok" \
    --arg adminsOk "$admins_ok" \
    --arg checksOk "$checks_ok" \
    --arg prReviewsEnabledOk "$pr_reviews_enabled_ok" \
    --arg approvingCountOk "$approving_count_ok" \
    --arg codeOwnerOk "$code_owner_ok" \
    --argjson requiredChecks "$(printf '%s\n' "${required_checks[@]}" | jq -R . | jq -s .)" \
    --argjson contextsCurrent "$(printf '%s\n' "${contexts_current[@]}" | jq -R . | jq -s .)" \
    --arg checksMissing "$checks_missing_csv" \
    '{
      repo: $repo,
      branch: $branch,
      requireStrict: ($requireStrict == "true"),
      strictCurrent: ($strictCurrent == "true"),
      requireEnforceAdmins: ($requireEnforceAdmins == "true"),
      enforceAdminsCurrent: ($enforceAdminsCurrent == "true"),
      requirePrReviews: ($requirePrReviews == "true"),
      minApprovingReviewCount: ($minApprovingReviewCount | tonumber),
      prReviewsRequiredCurrent: ($prReviewsRequiredCurrent == "true"),
      approvingReviewCountCurrent: ($approvingReviewCountCurrent | tonumber),
      requireCodeOwnerReviews: ($requireCodeOwnerReviews == "true"),
      codeOwnerReviewsCurrent: ($codeOwnerReviewsCurrent == "true"),
      strictOk: ($strictOk == "true"),
      adminsOk: ($adminsOk == "true"),
      checksOk: ($checksOk == "true"),
      prReviewsEnabledOk: ($prReviewsEnabledOk == "true"),
      approvingCountOk: ($approvingCountOk == "true"),
      codeOwnerOk: ($codeOwnerOk == "true"),
      requiredChecks: $requiredChecks,
      contextsCurrent: $contextsCurrent,
      checksMissing: (if ($checksMissing | length) == 0 then [] else ($checksMissing | split(",")) end),
      ok: (($strictOk == "true") and ($adminsOk == "true") and ($checksOk == "true") and ($prReviewsEnabledOk == "true") and ($approvingCountOk == "true") and ($codeOwnerOk == "true"))
    }' >"$OUTPUT_JSON"
fi

if [[ "$require_strict" == "true" && "$strict_current" != "true" ]]; then
  die "STRICT_NOT_ENABLED" "required_status_checks.strict=false but REQUIRE_STRICT=true"
fi

if [[ "$require_enforce_admins" == "true" && "$enforce_admins_current" != "true" ]]; then
  die "ENFORCE_ADMINS_DISABLED" "enforce_admins.enabled=false but REQUIRE_ENFORCE_ADMINS=true"
fi

if (( ${#missing_checks[@]} > 0 )); then
  die "REQUIRED_CHECKS_MISSING" "missing required checks: $(IFS=,; echo "${missing_checks[*]}")"
fi

if [[ "$require_pr_reviews" == "true" && "$pr_reviews_required_current" != "true" ]]; then
  die "PR_REVIEWS_NOT_ENABLED" "required_pull_request_reviews is not enabled but REQUIRE_PR_REVIEWS=true"
fi

if [[ "$require_pr_reviews" == "true" && "$approving_review_count_current" -lt "$min_approving_review_count" ]]; then
  die "APPROVING_REVIEW_COUNT_TOO_LOW" "required_approving_review_count=${approving_review_count_current} but expected >= ${min_approving_review_count}"
fi

if [[ "$require_code_owner_reviews" == "true" && "$code_owner_reviews_current" != "true" ]]; then
  die "CODE_OWNER_REVIEWS_NOT_ENABLED" "require_code_owner_reviews=false but REQUIRE_CODE_OWNER_REVIEWS=true"
fi

info "OK: required checks, strict/admin settings, and review settings are acceptable"
