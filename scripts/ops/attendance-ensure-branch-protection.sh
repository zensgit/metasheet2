#!/usr/bin/env bash
set -euo pipefail

REPO="${REPO:-${GITHUB_REPOSITORY:-zensgit/metasheet2}}"
BRANCH="${BRANCH:-main}"
REQUIRED_CHECKS_CSV="${REQUIRED_CHECKS_CSV:-contracts (strict),contracts (dashboard)}"
REQUIRE_STRICT="${REQUIRE_STRICT:-true}"
ENFORCE_ADMINS="${ENFORCE_ADMINS:-false}"
APPLY="${APPLY:-false}"

function die() {
  echo "[attendance-ensure-branch-protection] ERROR: $*" >&2
  exit 1
}

function info() {
  echo "[attendance-ensure-branch-protection] $*" >&2
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

command -v gh >/dev/null 2>&1 || die "gh is required"
command -v jq >/dev/null 2>&1 || die "jq is required"

if [[ "$REPO" != */* ]]; then
  die "REPO must be owner/name (got: $REPO)"
fi
owner="${REPO%%/*}"
repo_name="${REPO##*/}"

require_strict="$(bool_normalize "$REQUIRE_STRICT")"
enforce_admins="$(bool_normalize "$ENFORCE_ADMINS")"
apply_changes="$(bool_normalize "$APPLY")"

required_checks=()
IFS=',' read -r -a raw_required_checks <<< "$REQUIRED_CHECKS_CSV"
for raw in "${raw_required_checks[@]}"; do
  value="$(trim "$raw")"
  [[ -n "$value" ]] || continue
  required_checks+=("$value")
done
if (( ${#required_checks[@]} == 0 )); then
  die "no required checks configured from REQUIRED_CHECKS_CSV"
fi

contexts_json="$(printf '%s\n' "${required_checks[@]}" | jq -R . | jq -s .)"
payload="$(jq -n \
  --argjson strict "$require_strict" \
  --argjson contexts "$contexts_json" \
  --argjson enforce_admins "$enforce_admins" \
  '{
    required_status_checks: {
      strict: $strict,
      contexts: $contexts
    },
    enforce_admins: $enforce_admins,
    required_pull_request_reviews: null,
    restrictions: null
  }')"

info "repo=${REPO} branch=${BRANCH}"
info "required_checks=$(IFS=,; echo "${required_checks[*]}")"
info "require_strict=${require_strict} enforce_admins=${enforce_admins}"

if [[ "$apply_changes" != "true" ]]; then
  info "APPLY=false (dry-run). No branch protection changes will be applied."
  echo "$payload" | jq .
  exit 0
fi

tmp_dir="$(mktemp -d)"
cleanup() { rm -rf "$tmp_dir"; }
trap cleanup EXIT
payload_path="${tmp_dir}/payload.json"
printf '%s\n' "$payload" > "$payload_path"

info "Applying branch protection via GitHub API..."
gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  "/repos/${owner}/${repo_name}/branches/${BRANCH}/protection" \
  --input "$payload_path" >/dev/null

info "Verifying branch protection drift..."
REPO="$REPO" \
BRANCH="$BRANCH" \
REQUIRED_CHECKS_CSV="$REQUIRED_CHECKS_CSV" \
REQUIRE_STRICT="$REQUIRE_STRICT" \
./scripts/ops/attendance-check-branch-protection.sh

info "OK: branch protection applied and verified"
