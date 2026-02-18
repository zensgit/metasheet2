#!/usr/bin/env bash
set -euo pipefail

REPO="${REPO:-${GITHUB_REPOSITORY:-zensgit/metasheet2}}"
BRANCH="${BRANCH:-main}"
REQUIRED_CHECKS_CSV="${REQUIRED_CHECKS_CSV:-contracts (strict),contracts (dashboard)}"
REQUIRE_STRICT="${REQUIRE_STRICT:-true}"
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
info "required_checks=$(IFS=,; echo "${required_checks[*]}") require_strict=${require_strict}"

tmp_dir="$(mktemp -d)"
cleanup() { rm -rf "$tmp_dir"; }
trap cleanup EXIT

protection_json="${tmp_dir}/protection.json"
protection_err="${tmp_dir}/protection.err"

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
  die "API_FAILED" "failed to fetch branch protection: ${err_text:-unknown error}"
fi

strict_current="$(jq -r '.required_status_checks.strict // false' "$protection_json")"
mapfile -t contexts_current < <(jq -r '.required_status_checks.contexts[]? // empty' "$protection_json")

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

if [[ "$require_strict" == "true" && "$strict_current" != "true" ]]; then
  die "STRICT_NOT_ENABLED" "required_status_checks.strict=false but REQUIRE_STRICT=true"
fi

if (( ${#missing_checks[@]} > 0 )); then
  die "REQUIRED_CHECKS_MISSING" "missing required checks: $(IFS=,; echo "${missing_checks[*]}")"
fi

if [[ -n "$OUTPUT_JSON" ]]; then
  mkdir -p "$(dirname "$OUTPUT_JSON")"
  jq -n \
    --arg repo "$REPO" \
    --arg branch "$BRANCH" \
    --arg requireStrict "$require_strict" \
    --arg strictCurrent "$strict_current" \
    --argjson requiredChecks "$(printf '%s\n' "${required_checks[@]}" | jq -R . | jq -s .)" \
    --argjson contextsCurrent "$(printf '%s\n' "${contexts_current[@]}" | jq -R . | jq -s .)" \
    '{
      repo: $repo,
      branch: $branch,
      requireStrict: ($requireStrict == "true"),
      strictCurrent: ($strictCurrent == "true"),
      requiredChecks: $requiredChecks,
      contextsCurrent: $contextsCurrent,
      ok: true
    }' >"$OUTPUT_JSON"
fi

info "strict_current=${strict_current}"
info "contexts_current=$(IFS=,; echo "${contexts_current[*]}")"
info "OK: required checks present and strict setting is acceptable"
