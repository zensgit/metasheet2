#!/usr/bin/env bash
set -euo pipefail

function die() {
  echo "[backfill-dingtalk-corp-identities] ERROR: $*" >&2
  exit 1
}

function info() {
  echo "[backfill-dingtalk-corp-identities] $*" >&2
}

function require_psql() {
  command -v psql >/dev/null 2>&1 || die "psql is required"
}

function usage() {
  cat <<'EOF'
Usage:
  backfill-dingtalk-corp-identities.sh --corp-id <corpId> [--export-file <path>]
  backfill-dingtalk-corp-identities.sh --corp-id <corpId> --allowlist-file <path> --reviewed-plan <path> --apply

Environment:
  DATABASE_URL  PostgreSQL connection string (required)

Behavior:
  - default mode is dry-run
  - --export-file writes candidate rows to CSV for manual review
  - apply requires separate authorization for this environment/operator and a reviewed plan
  - the plan describes database system identifier, database, schema, session user, target corp,
    and the reviewed identity rows (see packages/core-backend/scripts/dingtalk-corp-backfill.ts)
  - the allowlist must exactly match the reviewed rows; neither file grants permission
EOF
}

CORP_ID=""
APPLY=0
EXPORT_FILE=""
ALLOWLIST_FILE=""
REVIEWED_PLAN=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --corp-id)
      [[ $# -ge 2 ]] || die "--corp-id requires a value"
      CORP_ID="$2"
      shift 2
      ;;
    --export-file)
      [[ $# -ge 2 ]] || die "--export-file requires a value"
      EXPORT_FILE="$2"
      shift 2
      ;;
    --allowlist-file)
      [[ $# -ge 2 ]] || die "--allowlist-file requires a value"
      ALLOWLIST_FILE="$2"
      shift 2
      ;;
    --reviewed-plan)
      [[ $# -ge 2 ]] || die "--reviewed-plan requires a value"
      REVIEWED_PLAN="$2"
      shift 2
      ;;
    --apply)
      APPLY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[[ -n "${DATABASE_URL:-}" ]] || die "DATABASE_URL is required"
[[ -n "${CORP_ID}" ]] || die "--corp-id is required"
if (( APPLY == 1 )); then
  [[ -n "${ALLOWLIST_FILE}" && -n "${REVIEWED_PLAN}" ]] || die "--apply requires --allowlist-file and --reviewed-plan after separate operation approval"
  [[ -z "${EXPORT_FILE}" ]] || die "--export-file is only valid for preview"
  backend_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../packages/core-backend" && pwd)"
  exec node "${backend_dir}/node_modules/tsx/dist/cli.mjs" "${backend_dir}/scripts/dingtalk-corp-backfill.ts" "${CORP_ID}" "${ALLOWLIST_FILE}" "${REVIEWED_PLAN}"
fi
[[ -z "${ALLOWLIST_FILE}" && -z "${REVIEWED_PLAN}" ]] || die "--allowlist-file and --reviewed-plan are for --apply"
require_psql

function read_counts_sql() {
  cat <<'EOF'
WITH candidate_rows AS (
  SELECT
    id,
    local_user_id,
    provider_open_id,
    provider_union_id,
    corp_id,
    external_key,
    created_at,
    updated_at
  FROM user_external_identities
  WHERE provider = 'dingtalk'
    AND corp_id IS NULL
    AND provider_open_id IS NOT NULL
),
missing_open_id_rows AS (
  SELECT count(*)::bigint AS count
  FROM user_external_identities
  WHERE provider = 'dingtalk'
    AND corp_id IS NULL
    AND provider_open_id IS NULL
),
conflict_rows AS (
  SELECT count(*)::bigint AS count
  FROM candidate_rows c
  WHERE EXISTS (
    SELECT 1
    FROM user_external_identities existing
    WHERE existing.provider = 'dingtalk'
      AND existing.external_key = :'corp_id' || ':' || c.provider_open_id
      AND existing.id <> c.id
  )
)
SELECT json_build_object(
  'candidate_rows', (SELECT count(*)::bigint FROM candidate_rows),
  'missing_open_id_rows', (SELECT count FROM missing_open_id_rows),
  'conflict_rows', (SELECT count FROM conflict_rows),
  'apply_rows', (
    SELECT count(*)::bigint
    FROM candidate_rows c
    WHERE NOT EXISTS (
      SELECT 1
      FROM user_external_identities existing
      WHERE existing.provider = 'dingtalk'
        AND existing.external_key = :'corp_id' || ':' || c.provider_open_id
        AND existing.id <> c.id
    )
  )
)::text;
EOF
}

function candidate_export_sql() {
  cat <<'EOF'
COPY (
  SELECT
    id AS identity_id,
    local_user_id,
    provider_open_id,
    provider_union_id,
    external_key,
    corp_id,
    created_at,
    updated_at,
    xmin::text AS row_version
  FROM user_external_identities
  WHERE provider = 'dingtalk'
    AND corp_id IS NULL
    AND provider_open_id IS NOT NULL
  ORDER BY updated_at DESC, created_at DESC, id DESC
) TO STDOUT WITH CSV HEADER
EOF
}

COUNTS_JSON="$(
  psql "${DATABASE_URL}" \
    --no-psqlrc \
    --set ON_ERROR_STOP=1 \
    --set "corp_id=${CORP_ID}" \
    --tuples-only \
    --quiet \
    --file - <<< "$(read_counts_sql)"
)"

COUNTS_JSON="$(printf '%s' "${COUNTS_JSON}" | tr -d '\n' | sed 's/^ *//; s/ *$//')"
[[ -n "${COUNTS_JSON}" ]] || die "failed to read candidate counts"

COUNTS_JSON="${COUNTS_JSON}" python3 - <<'PY'
import json
import os
payload = json.loads(os.environ["COUNTS_JSON"])
for key in ("candidate_rows", "missing_open_id_rows", "conflict_rows", "apply_rows"):
    print(f"{key}={payload[key]}")
PY

if [[ -n "${EXPORT_FILE}" ]]; then
  mkdir -p "$(dirname "${EXPORT_FILE}")"
  psql "${DATABASE_URL}" \
    --no-psqlrc \
    --set ON_ERROR_STOP=1 \
    --quiet \
    --command "$(candidate_export_sql)" > "${EXPORT_FILE}"
  info "exported DingTalk corpId backfill candidates to ${EXPORT_FILE}"
fi

info "dry-run complete"
