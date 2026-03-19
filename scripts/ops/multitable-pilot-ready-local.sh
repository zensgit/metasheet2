#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

timestamp="$(date +%Y%m%d-%H%M%S)"
OUTPUT_ROOT="${OUTPUT_ROOT:-output/playwright/multitable-pilot-ready-local/${timestamp}}"
SMOKE_ROOT="${OUTPUT_ROOT}/smoke"
PROFILE_ROOT="${OUTPUT_ROOT}/profile"
READINESS_MD="${OUTPUT_ROOT}/readiness.md"
READINESS_JSON="${OUTPUT_ROOT}/readiness.json"
ROW_COUNT="${ROW_COUNT:-2000}"
FALLBACK_OUTPUT_ROOT="${FALLBACK_OUTPUT_ROOT:-output/playwright/multitable-pilot-ready-local-current}"

if ! mkdir -p "$SMOKE_ROOT" "$PROFILE_ROOT" 2>/dev/null; then
  echo "[multitable-pilot-ready-local] WARN: failed to create ${OUTPUT_ROOT}, falling back to ${FALLBACK_OUTPUT_ROOT}" >&2
  OUTPUT_ROOT="$FALLBACK_OUTPUT_ROOT"
  SMOKE_ROOT="${OUTPUT_ROOT}/smoke"
  PROFILE_ROOT="${OUTPUT_ROOT}/profile"
  READINESS_MD="${OUTPUT_ROOT}/readiness.md"
  READINESS_JSON="${OUTPUT_ROOT}/readiness.json"
  mkdir -p "$SMOKE_ROOT" "$PROFILE_ROOT"
fi

echo "[multitable-pilot-ready-local] Running multitable pilot smoke" >&2
OUTPUT_ROOT="$SMOKE_ROOT" \
ENSURE_PLAYWRIGHT="${ENSURE_PLAYWRIGHT:-true}" \
HEADLESS="${HEADLESS:-true}" \
TIMEOUT_MS="${TIMEOUT_MS:-30000}" \
API_BASE="${API_BASE:-http://127.0.0.1:7778}" \
WEB_BASE="${WEB_BASE:-http://127.0.0.1:8899}" \
PILOT_DATABASE_URL="${PILOT_DATABASE_URL:-postgresql://metasheet:metasheet@127.0.0.1:5435/metasheet}" \
RBAC_TOKEN_TRUST="${RBAC_TOKEN_TRUST:-true}" \
pnpm verify:multitable-pilot:local

echo "[multitable-pilot-ready-local] Running multitable grid profile" >&2
OUTPUT_ROOT="$PROFILE_ROOT" \
ROW_COUNT="$ROW_COUNT" \
ENSURE_PLAYWRIGHT=false \
HEADLESS="${HEADLESS:-true}" \
TIMEOUT_MS="${TIMEOUT_MS:-30000}" \
API_BASE="${API_BASE:-http://127.0.0.1:7778}" \
WEB_BASE="${WEB_BASE:-http://127.0.0.1:8899}" \
PILOT_DATABASE_URL="${PILOT_DATABASE_URL:-postgresql://metasheet:metasheet@127.0.0.1:5435/metasheet}" \
RBAC_TOKEN_TRUST="${RBAC_TOKEN_TRUST:-true}" \
pnpm profile:multitable-grid:local

echo "[multitable-pilot-ready-local] Validating profile thresholds" >&2
REPORT_JSON="${PROFILE_ROOT}/report.json" \
SUMMARY_MD="${PROFILE_ROOT}/summary.md" \
UI_GRID_OPEN_MAX_MS="${UI_GRID_OPEN_MAX_MS:-350}" \
UI_GRID_SEARCH_HIT_MAX_MS="${UI_GRID_SEARCH_HIT_MAX_MS:-300}" \
API_GRID_INITIAL_LOAD_MAX_MS="${API_GRID_INITIAL_LOAD_MAX_MS:-25}" \
API_GRID_SEARCH_HIT_MAX_MS="${API_GRID_SEARCH_HIT_MAX_MS:-25}" \
pnpm verify:multitable-grid-profile:summary

echo "[multitable-pilot-ready-local] Writing readiness summary" >&2
SMOKE_REPORT_JSON="${SMOKE_ROOT}/report.json" \
PROFILE_REPORT_JSON="${PROFILE_ROOT}/report.json" \
PROFILE_SUMMARY_MD="${PROFILE_ROOT}/summary.md" \
READINESS_MD="${READINESS_MD}" \
READINESS_JSON="${READINESS_JSON}" \
pnpm verify:multitable-pilot:readiness

echo "[multitable-pilot-ready-local] PASS: readiness complete" >&2
echo "[multitable-pilot-ready-local] readiness_md=${READINESS_MD}" >&2
echo "[multitable-pilot-ready-local] readiness_json=${READINESS_JSON}" >&2
