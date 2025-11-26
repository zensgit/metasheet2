#!/usr/bin/env bash
set -euo pipefail

# Phase 5 Grafana Dashboard Deployment Helper
# -------------------------------------------
# Wraps an existing dashboard JSON into the Grafana HTTP API payload and uploads it.
# Supports dry-run, folder assignment, and token authentication.
#
# Environment Variables:
#   GRAFANA_URL            Base URL (e.g. https://grafana.example.com)
#   GRAFANA_API_TOKEN      Grafana API token with dashboard write perms
#   DASHBOARD_JSON         Path to dashboard JSON (default ops/grafana/dashboards/phase5-slo.json)
#   GRAFANA_FOLDER_ID      Numeric folder id (optional, defaults to General)
#   DRY_RUN                If 'true' skip upload, just validate
#
# Usage Examples:
#   bash scripts/phase5-deploy-grafana-dashboard.sh
#   GRAFANA_URL=http://localhost:3000 GRAFANA_API_TOKEN=XXX bash scripts/phase5-deploy-grafana-dashboard.sh
#   DRY_RUN=true DASHBOARD_JSON=custom.json bash scripts/phase5-deploy-grafana-dashboard.sh

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DASHBOARD_JSON_PATH="${DASHBOARD_JSON:-${ROOT_DIR}/ops/grafana/dashboards/phase5-slo.json}"
OUT_DIR="${ROOT_DIR}/artifacts/grafana"
mkdir -p "${OUT_DIR}"

if [ ! -f "${DASHBOARD_JSON_PATH}" ]; then
  echo "[grafana][error] Dashboard JSON not found: ${DASHBOARD_JSON_PATH}" >&2
  exit 1
fi

echo "[grafana] Using dashboard: ${DASHBOARD_JSON_PATH}" >&2

# Basic JSON lint using jq or python as fallback
lint_json() {
  local file="$1"
  if command -v jq >/dev/null 2>&1; then
    jq '.' "$file" >/dev/null || { echo "[grafana][error] Invalid JSON (jq parse failed)." >&2; exit 1; }
  else
    python - <<'PY' "$file" || exit 1
import sys, json
with open(sys.argv[1],'r',encoding='utf-8') as f:
    json.load(f)
print('JSON_OK')
PY
  fi
}

lint_json "${DASHBOARD_JSON_PATH}"

FOLDER_ID="${GRAFANA_FOLDER_ID:-0}" # 0 = General

PAYLOAD_FILE="${OUT_DIR}/phase5-dashboard-payload.json"

# Wrap dashboard JSON into Grafana API structure
{
  echo '{"dashboard":'
  cat "${DASHBOARD_JSON_PATH}"
  echo ',"folderId":'"${FOLDER_ID}"',"overwrite":true}'
} > "${PAYLOAD_FILE}"

echo "[grafana] Payload prepared: ${PAYLOAD_FILE}" >&2

if [ "${DRY_RUN:-false}" = "true" ]; then
  echo "[grafana] DRY_RUN=true; skipping upload." >&2
  exit 0
fi

if [ -z "${GRAFANA_URL:-}" ]; then
  echo "[grafana][warn] GRAFANA_URL not set; skipping upload." >&2
  exit 0
fi
if [ -z "${GRAFANA_API_TOKEN:-}" ]; then
  echo "[grafana][warn] GRAFANA_API_TOKEN not set; skipping upload." >&2
  exit 0
fi

echo "[grafana] Uploading to ${GRAFANA_URL}/api/dashboards/db (folderId=${FOLDER_ID})" >&2

HTTP_CODE=$(curl -sS -w '%{http_code}' -o "${OUT_DIR}/grafana-response.json" \
  -H "Authorization: Bearer ${GRAFANA_API_TOKEN}" \
  -H 'Content-Type: application/json' \
  -X POST "${GRAFANA_URL}/api/dashboards/db" \
  --data-binary @"${PAYLOAD_FILE}" || true)

echo "[grafana] HTTP_CODE=${HTTP_CODE}" >&2
if [ "${HTTP_CODE}" != "200" ] && [ "${HTTP_CODE}" != "201" ]; then
  echo "[grafana][error] Upload failed; see ${OUT_DIR}/grafana-response.json" >&2
  exit 1
fi

echo "[grafana] Upload complete. Response saved to ${OUT_DIR}/grafana-response.json" >&2
echo "[grafana] Done." >&2

