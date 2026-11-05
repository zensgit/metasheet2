#!/usr/bin/env bash
# dingtalk-lifecycle-canary-accept-digests-at-deploy-sha.sh <deploy_sha> [accept_table] [repo_dir]
#
# Binds the lifecycle canary accept table to the DEPLOYED migration sources. For every
# accepted line "<migration_name> <sha256>", the migration source
# packages/core-backend/src/db/migrations/<migration_name>.ts as committed at <deploy_sha> must
# hash (sha256 of the blob bytes) to the accepted digest. The required CI consistency test
# binds the same table to the sources of the PR head; this script binds it to the commit
# that is actually deployed, before the canary workflow dispatches to the host.
#
# Runs on the workflow runner against the repository checkout (the commit object of
# <deploy_sha> must be present, e.g. after `git fetch --depth=1 origin <deploy_sha>`).
# Read-only: git cat-file / rev-parse only.
#
# Output (values-free key=value lines; never a digest or a migration name):
#   accept_digests_at_deploy_sha=true|false|unknown
#   accept_digests_reason=<enum>
#   accepted_names=<count>|unknown
#   accepted_names_matched=<count>|unknown
# Exit: 0 true (every accepted digest matches; an empty table binds nothing), 1 false
# (a source is missing at deploy_sha or its digest differs), 2 unknown (invalid sha, the
# commit is not available, the table is unreadable or malformed, no sha256 tool).
# The table line shape is the canary runtime reader's: one "<[A-Za-z0-9_]+> <64 lowercase
# hex>" per non-comment line, no repeated name.
set -euo pipefail

DEPLOY_SHA="${1:-}"
ACCEPT_TABLE="${2:-scripts/ops/dingtalk-lifecycle-staging-canary-accepted-exclusions.txt}"
REPO_DIR="${3:-.}"
MIGRATIONS_PREFIX="packages/core-backend/src/db/migrations"

emit() {
  # emit <verdict> <reason> <names> <matched> <exit code>
  printf 'accept_digests_at_deploy_sha=%s\n' "$1"
  printf 'accept_digests_reason=%s\n' "$2"
  printf 'accepted_names=%s\n' "$3"
  printf 'accepted_names_matched=%s\n' "$4"
  exit "$5"
}

sha256_stdin() {
  if command -v sha256sum > /dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  elif command -v shasum > /dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  else
    return 1
  fi
}

[[ "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]] || emit unknown deploy_sha_invalid unknown unknown 2
[[ -r "$ACCEPT_TABLE" ]] || emit unknown accept_table_unreadable unknown unknown 2

names=()
digests=()
seen=","
while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ -z "${line//[[:space:]]/}" || "$line" == \#* ]]; then
    continue
  fi
  [[ "$line" =~ ^([A-Za-z0-9_]+)[[:space:]]+([0-9a-f]{64})[[:space:]]*$ ]] \
    || emit unknown accept_table_malformed unknown unknown 2
  name="${BASH_REMATCH[1]}"
  [[ "$seen" != *",${name},"* ]] || emit unknown accept_table_malformed unknown unknown 2
  seen="${seen}${name},"
  names+=("$name")
  digests+=("${BASH_REMATCH[2]}")
done < "$ACCEPT_TABLE"

total="${#names[@]}"
git -C "$REPO_DIR" cat-file -e "${DEPLOY_SHA}^{commit}" 2>/dev/null \
  || emit unknown deploy_sha_unavailable "$total" unknown 2
if [[ "$total" -eq 0 ]]; then
  emit true no_accepted_names 0 0 0
fi
printf '' | sha256_stdin > /dev/null 2>&1 || emit unknown sha256_tool_unavailable "$total" unknown 2

matched=0
missing=0
mismatched=0
for i in "${!names[@]}"; do
  blob=""
  if ! blob="$(git -C "$REPO_DIR" rev-parse --verify --quiet "${DEPLOY_SHA}:${MIGRATIONS_PREFIX}/${names[$i]}.ts" 2>/dev/null)" || [[ -z "$blob" ]]; then
    missing=$((missing + 1))
    continue
  fi
  actual=""
  if ! actual="$(git -C "$REPO_DIR" cat-file blob "$blob" | sha256_stdin)" || [[ ! "$actual" =~ ^[0-9a-f]{64}$ ]]; then
    emit unknown source_unreadable_at_deploy_sha "$total" unknown 2
  fi
  if [[ "$actual" == "${digests[$i]}" ]]; then
    matched=$((matched + 1))
  else
    mismatched=$((mismatched + 1))
  fi
done

if [[ "$missing" -gt 0 ]]; then
  emit false source_missing_at_deploy_sha "$total" "$matched" 1
fi
if [[ "$mismatched" -gt 0 ]]; then
  emit false digest_mismatch_at_deploy_sha "$total" "$matched" 1
fi
emit true all_digests_match "$total" "$matched" 0
