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
  backfill-dingtalk-corp-identities.sh --corp-id <corpId> [--apply]

Environment:
  DATABASE_URL  PostgreSQL connection string (required)

Behavior:
  - default mode is dry-run
  - --apply performs the update after safety checks pass
EOF
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CORP_ID=""
APPLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --corp-id)
      [[ $# -ge 2 ]] || die "--corp-id requires a value"
      CORP_ID="$2"
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

read_counts_sql() {
  cat <<'EOF'
WITH candidate_rows AS (
  SELECT
    id,
    provider_open_id,
    corp_id,
    external_key
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

CANDIDATE_ROWS="$(COUNTS_JSON="${COUNTS_JSON}" python3 - <<'PY'
import json, os
print(json.loads(os.environ["COUNTS_JSON"])["candidate_rows"])
PY
)"
MISSING_OPEN_ID_ROWS="$(COUNTS_JSON="${COUNTS_JSON}" python3 - <<'PY'
import json, os
print(json.loads(os.environ["COUNTS_JSON"])["missing_open_id_rows"])
PY
)"
CONFLICT_ROWS="$(COUNTS_JSON="${COUNTS_JSON}" python3 - <<'PY'
import json, os
print(json.loads(os.environ["COUNTS_JSON"])["conflict_rows"])
PY
)"
APPLY_ROWS="$(COUNTS_JSON="${COUNTS_JSON}" python3 - <<'PY'
import json, os
print(json.loads(os.environ["COUNTS_JSON"])["apply_rows"])
PY
)"

if (( MISSING_OPEN_ID_ROWS > 0 )); then
  die "found ${MISSING_OPEN_ID_ROWS} legacy DingTalk identity rows with corp_id IS NULL and provider_open_id IS NULL; resolve them manually before corpId rollout"
fi

if (( CONFLICT_ROWS > 0 )); then
  die "found ${CONFLICT_ROWS} corp-scoped external_key conflicts; resolve conflicts before corpId rollout"
fi

if (( APPLY == 0 )); then
  info "dry-run complete for corpId=${CORP_ID} in ${ROOT_DIR}"
  exit 0
fi

UPDATE_COUNT="$(
  psql "${DATABASE_URL}" \
    --no-psqlrc \
    --set ON_ERROR_STOP=1 \
    --set "corp_id=${CORP_ID}" \
    --tuples-only \
    --quiet \
    <<'SQL'
WITH updated AS (
  UPDATE user_external_identities identity
  SET
    corp_id = :'corp_id',
    external_key = :'corp_id' || ':' || identity.provider_open_id,
    updated_at = now()
  WHERE identity.provider = 'dingtalk'
    AND identity.corp_id IS NULL
    AND identity.provider_open_id IS NOT NULL
  RETURNING 1
)
SELECT count(*)::bigint FROM updated;
SQL
)"

UPDATE_COUNT="$(printf '%s' "${UPDATE_COUNT}" | tr -d '\n' | sed 's/^ *//; s/ *$//')"
info "applied corpId backfill for ${UPDATE_COUNT} legacy DingTalk identity rows"
