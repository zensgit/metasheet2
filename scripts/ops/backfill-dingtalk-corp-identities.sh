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
  backfill-dingtalk-corp-identities.sh --corp-id <corpId> --allowlist-file <path> --apply

Environment:
  DATABASE_URL  PostgreSQL connection string (required)

Behavior:
  - default mode is dry-run
  - --export-file writes candidate rows to CSV for manual review
  - --apply requires --allowlist-file and only updates allowlisted identity ids
EOF
}

CORP_ID=""
APPLY=0
EXPORT_FILE=""
ALLOWLIST_FILE=""
ALLOWLIST_NORMALIZED=""

function cleanup() {
  if [[ -n "${ALLOWLIST_NORMALIZED}" && -f "${ALLOWLIST_NORMALIZED}" ]]; then
    rm -f "${ALLOWLIST_NORMALIZED}"
  fi
}

trap cleanup EXIT

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
require_psql

if (( APPLY == 1 )) && [[ -z "${ALLOWLIST_FILE}" ]]; then
  die "--apply requires --allowlist-file"
fi

if (( APPLY == 0 )) && [[ -n "${ALLOWLIST_FILE}" ]]; then
  die "--allowlist-file is only valid together with --apply"
fi

function sanitize_allowlist_file() {
  local source_file="$1"
  [[ -f "${source_file}" ]] || die "allowlist file not found: ${source_file}"

  local tmp_file
  tmp_file="$(mktemp "${TMPDIR:-/tmp}/dingtalk-corp-allowlist.XXXXXX.csv")"
  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="${line%%#*}"
    line="$(printf '%s' "${line}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    [[ -n "${line}" ]] || continue
    printf '%s\n' "${line}" >> "${tmp_file}"
  done < "${source_file}"

  [[ -s "${tmp_file}" ]] || die "allowlist file contains no usable identity ids: ${source_file}"
  ALLOWLIST_NORMALIZED="${tmp_file}"
}

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
    updated_at
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
    --command "$(read_counts_sql)"
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

MISSING_OPEN_ID_ROWS="$(
  COUNTS_JSON="${COUNTS_JSON}" python3 - <<'PY'
import json, os
print(json.loads(os.environ["COUNTS_JSON"])["missing_open_id_rows"])
PY
)"
CONFLICT_ROWS="$(
  COUNTS_JSON="${COUNTS_JSON}" python3 - <<'PY'
import json, os
print(json.loads(os.environ["COUNTS_JSON"])["conflict_rows"])
PY
)"

if [[ -n "${EXPORT_FILE}" ]]; then
  mkdir -p "$(dirname "${EXPORT_FILE}")"
  psql "${DATABASE_URL}" \
    --no-psqlrc \
    --set ON_ERROR_STOP=1 \
    --quiet \
    --command "$(candidate_export_sql)" > "${EXPORT_FILE}"
  info "exported DingTalk corpId backfill candidates to ${EXPORT_FILE}"
fi

if (( APPLY == 0 )); then
  info "dry-run complete for corpId=${CORP_ID}"
  exit 0
fi

sanitize_allowlist_file "${ALLOWLIST_FILE}"

if (( MISSING_OPEN_ID_ROWS > 0 )); then
  die "found ${MISSING_OPEN_ID_ROWS} legacy DingTalk identity rows with corp_id IS NULL and provider_open_id IS NULL; resolve them manually before corpId rollout"
fi

if (( CONFLICT_ROWS > 0 )); then
  die "found ${CONFLICT_ROWS} corp-scoped external_key conflicts; resolve conflicts before corpId rollout"
fi

APPLY_JSON="$(
  psql "${DATABASE_URL}" \
    --no-psqlrc \
    --set ON_ERROR_STOP=1 \
    --set "corp_id=${CORP_ID}" \
    --set "allowlist_file=${ALLOWLIST_NORMALIZED}" \
    --tuples-only \
    --quiet <<'SQL'
CREATE TEMP TABLE dingtalk_allowlist (
  identity_id text PRIMARY KEY
) ON COMMIT DROP;

\copy dingtalk_allowlist (identity_id) FROM :'allowlist_file' WITH (FORMAT csv)

WITH allowlisted AS (
  SELECT identity_id
  FROM dingtalk_allowlist
),
missing_rows AS (
  SELECT a.identity_id
  FROM allowlisted a
  LEFT JOIN user_external_identities identity ON identity.id::text = a.identity_id
  WHERE identity.id IS NULL
),
invalid_candidate_rows AS (
  SELECT a.identity_id
  FROM allowlisted a
  JOIN user_external_identities identity ON identity.id::text = a.identity_id
  WHERE NOT (
    identity.provider = 'dingtalk'
    AND identity.corp_id IS NULL
    AND identity.provider_open_id IS NOT NULL
  )
),
conflict_rows AS (
  SELECT a.identity_id
  FROM allowlisted a
  JOIN user_external_identities identity ON identity.id::text = a.identity_id
  WHERE EXISTS (
    SELECT 1
    FROM user_external_identities existing
    WHERE existing.provider = 'dingtalk'
      AND existing.external_key = :'corp_id' || ':' || identity.provider_open_id
      AND existing.id <> identity.id
  )
),
updatable_rows AS (
  SELECT identity.id
  FROM allowlisted a
  JOIN user_external_identities identity ON identity.id::text = a.identity_id
  WHERE identity.provider = 'dingtalk'
    AND identity.corp_id IS NULL
    AND identity.provider_open_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM user_external_identities existing
      WHERE existing.provider = 'dingtalk'
        AND existing.external_key = :'corp_id' || ':' || identity.provider_open_id
        AND existing.id <> identity.id
    )
)
SELECT json_build_object(
  'allowlisted_rows', (SELECT count(*)::bigint FROM allowlisted),
  'missing_rows', (SELECT count(*)::bigint FROM missing_rows),
  'invalid_candidate_rows', (SELECT count(*)::bigint FROM invalid_candidate_rows),
  'conflict_rows', (SELECT count(*)::bigint FROM conflict_rows),
  'updatable_rows', (SELECT count(*)::bigint FROM updatable_rows)
)::text;
SQL
)"

APPLY_JSON="$(printf '%s' "${APPLY_JSON}" | tr -d '\n' | sed 's/^ *//; s/ *$//')"
[[ -n "${APPLY_JSON}" ]] || die "failed to validate allowlist"

ALLOWLISTED_ROWS="$(
  APPLY_JSON="${APPLY_JSON}" python3 - <<'PY'
import json, os
print(json.loads(os.environ["APPLY_JSON"])["allowlisted_rows"])
PY
)"
MISSING_ROWS="$(
  APPLY_JSON="${APPLY_JSON}" python3 - <<'PY'
import json, os
print(json.loads(os.environ["APPLY_JSON"])["missing_rows"])
PY
)"
INVALID_CANDIDATE_ROWS="$(
  APPLY_JSON="${APPLY_JSON}" python3 - <<'PY'
import json, os
print(json.loads(os.environ["APPLY_JSON"])["invalid_candidate_rows"])
PY
)"
ALLOWLIST_CONFLICT_ROWS="$(
  APPLY_JSON="${APPLY_JSON}" python3 - <<'PY'
import json, os
print(json.loads(os.environ["APPLY_JSON"])["conflict_rows"])
PY
)"
UPDATABLE_ROWS="$(
  APPLY_JSON="${APPLY_JSON}" python3 - <<'PY'
import json, os
print(json.loads(os.environ["APPLY_JSON"])["updatable_rows"])
PY
)"

if (( ALLOWLISTED_ROWS == 0 )); then
  die "allowlist contains no identity ids"
fi
if (( MISSING_ROWS > 0 )); then
  die "allowlist contains ${MISSING_ROWS} unknown identity ids"
fi
if (( INVALID_CANDIDATE_ROWS > 0 )); then
  die "allowlist contains ${INVALID_CANDIDATE_ROWS} ids that are not eligible legacy DingTalk corp backfill candidates"
fi
if (( ALLOWLIST_CONFLICT_ROWS > 0 )); then
  die "allowlist contains ${ALLOWLIST_CONFLICT_ROWS} ids that would collide with existing corp-scoped external keys"
fi
if (( UPDATABLE_ROWS == 0 )); then
  die "allowlist did not select any updatable DingTalk identity rows"
fi

UPDATE_COUNT="$(
  psql "${DATABASE_URL}" \
    --no-psqlrc \
    --set ON_ERROR_STOP=1 \
    --set "corp_id=${CORP_ID}" \
    --set "allowlist_file=${ALLOWLIST_NORMALIZED}" \
    --tuples-only \
    --quiet <<'SQL'
CREATE TEMP TABLE dingtalk_allowlist (
  identity_id text PRIMARY KEY
) ON COMMIT DROP;

\copy dingtalk_allowlist (identity_id) FROM :'allowlist_file' WITH (FORMAT csv)

WITH updated AS (
  UPDATE user_external_identities identity
  SET
    corp_id = :'corp_id',
    external_key = :'corp_id' || ':' || identity.provider_open_id,
    updated_at = now()
  WHERE identity.id IN (SELECT identity_id::uuid FROM dingtalk_allowlist)
    AND identity.provider = 'dingtalk'
    AND identity.corp_id IS NULL
    AND identity.provider_open_id IS NOT NULL
  RETURNING 1
)
SELECT count(*)::bigint FROM updated;
SQL
)"

UPDATE_COUNT="$(printf '%s' "${UPDATE_COUNT}" | tr -d '\n' | sed 's/^ *//; s/ *$//')"
info "applied corpId backfill for ${UPDATE_COUNT} allowlisted DingTalk identity rows"
