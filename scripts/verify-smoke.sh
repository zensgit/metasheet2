#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

API_BASE="${API_BASE:-http://127.0.0.1:7778}"
WEB_BASE="${WEB_BASE:-http://127.0.0.1:8899}"
SMOKE_DATABASE_URL="${SMOKE_DATABASE_URL:-postgresql://metasheet:metasheet@127.0.0.1:5435/metasheet}"
RBAC_BYPASS="${RBAC_BYPASS:-true}"
SMOKE_SKIP_WEB="${SMOKE_SKIP_WEB:-false}"
SMOKE_SKIP_MIGRATE="${SMOKE_SKIP_MIGRATE:-false}"
RUN_UNIVER_UI_SMOKE="${RUN_UNIVER_UI_SMOKE:-false}"
RUN_PLM_UI_REGRESSION="${RUN_PLM_UI_REGRESSION:-false}"
RUN_PLM_UI_READONLY="${RUN_PLM_UI_READONLY:-false}"
PLM_BASE_URL="${PLM_BASE_URL:-http://127.0.0.1:7910}"
PLM_API_MODE="${PLM_API_MODE:-yuantus}"
PLM_TENANT_ID="${PLM_TENANT_ID:-tenant-1}"
PLM_ORG_ID="${PLM_ORG_ID:-org-1}"
PLM_USERNAME="${PLM_USERNAME:-admin}"
PLM_PASSWORD="${PLM_PASSWORD:-admin}"
PLM_BOM_TOOLS_JSON="${PLM_BOM_TOOLS_JSON:-}"
PLM_BOM_TOOLS_LATEST="${PLM_BOM_TOOLS_LATEST:-artifacts/plm-bom-tools-latest.json}"
OUTPUT_DIR="${OUTPUT_DIR:-artifacts/smoke}"

mkdir -p "$OUTPUT_DIR"

echo "== MetaSheet Smoke Verification =="
echo "- API_BASE: ${API_BASE}"
echo "- WEB_BASE: ${WEB_BASE}"
echo "- SMOKE_DATABASE_URL: ${SMOKE_DATABASE_URL}"
echo "- RBAC_BYPASS: ${RBAC_BYPASS}"
echo "- SMOKE_SKIP_WEB: ${SMOKE_SKIP_WEB}"
echo "- SMOKE_SKIP_MIGRATE: ${SMOKE_SKIP_MIGRATE}"
echo "- RUN_UNIVER_UI_SMOKE: ${RUN_UNIVER_UI_SMOKE}"
echo "- RUN_PLM_UI_REGRESSION: ${RUN_PLM_UI_REGRESSION}"
echo "- RUN_PLM_UI_READONLY: ${RUN_PLM_UI_READONLY}"
echo "- PLM_BASE_URL: ${PLM_BASE_URL}"
echo "- PLM_API_MODE: ${PLM_API_MODE}"
echo "- PLM_TENANT_ID: ${PLM_TENANT_ID}"
echo "- PLM_ORG_ID: ${PLM_ORG_ID}"
echo "- OUTPUT_DIR: ${OUTPUT_DIR}"
echo ""

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm not found. Please install pnpm first."
  exit 1
fi

if ! curl -fsS "${API_BASE}/health" >/dev/null 2>&1; then
  if [[ "${SMOKE_SKIP_MIGRATE}" != "true" ]]; then
    echo "[1/3] Preparing database..."
    DATABASE_URL="${SMOKE_DATABASE_URL}" pnpm --filter @metasheet/core-backend migrate >/dev/null
  else
    echo "[1/3] Skipping database migration (SMOKE_SKIP_MIGRATE=true)"
  fi

  echo "[2/3] Starting backend..."
  PORT="$(python3 - <<'PY'
from urllib.parse import urlparse
import os
u=urlparse(os.environ.get("API_BASE","http://127.0.0.1:7778"))
print(u.port or 7778)
PY
)"
  if [[ "${RUN_PLM_UI_REGRESSION}" == "true" || "${RUN_PLM_UI_READONLY}" == "true" ]]; then
    PORT="${PORT}" DATABASE_URL="${SMOKE_DATABASE_URL}" DISABLE_WORKFLOW=true DISABLE_EVENT_BUS=true SKIP_PLUGINS=true RBAC_BYPASS="${RBAC_BYPASS}" \
      PLM_BASE_URL="${PLM_BASE_URL}" PLM_API_MODE="${PLM_API_MODE}" PLM_TENANT_ID="${PLM_TENANT_ID}" PLM_ORG_ID="${PLM_ORG_ID}" \
      PLM_USERNAME="${PLM_USERNAME}" PLM_PASSWORD="${PLM_PASSWORD}" \
      pnpm --filter @metasheet/core-backend dev:core > "${OUTPUT_DIR}/backend.log" 2>&1 &
  else
    PORT="${PORT}" DATABASE_URL="${SMOKE_DATABASE_URL}" DISABLE_WORKFLOW=true DISABLE_EVENT_BUS=true SKIP_PLUGINS=true RBAC_BYPASS="${RBAC_BYPASS}" \
      pnpm --filter @metasheet/core-backend dev:core > "${OUTPUT_DIR}/backend.log" 2>&1 &
  fi
  BACK_PID=$!

  for i in {1..30}; do
    if curl -fsS "${API_BASE}/health" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  if ! curl -fsS "${API_BASE}/health" >/dev/null 2>&1; then
    echo "Backend failed to start (see ${OUTPUT_DIR}/backend.log)" >&2
    exit 1
  fi
else
  BACK_PID=""
  echo "[1/3] Backend already running"
fi

if ! curl -fsS "${WEB_BASE}/" >/dev/null 2>&1; then
  echo "[3/3] Starting web..."
  pnpm --filter @metasheet/web dev -- --host 127.0.0.1 --port 8899 > "${OUTPUT_DIR}/web.log" 2>&1 &
  WEB_PID=$!
  for i in {1..30}; do
    if curl -fsS "${WEB_BASE}/" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  if ! curl -fsS "${WEB_BASE}/" >/dev/null 2>&1; then
    echo "Web failed to start (see ${OUTPUT_DIR}/web.log)" >&2
    exit 1
  fi
else
  WEB_PID=""
  echo "[3/3] Web already running"
fi

cleanup() {
  if [[ -n "${BACK_PID}" ]]; then
    kill "${BACK_PID}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${WEB_PID}" ]]; then
    kill "${WEB_PID}" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT INT TERM

echo ""
echo "Running smoke suite..."
API_BASE="${API_BASE}" WEB_BASE="${WEB_BASE}" OUTPUT_PATH="${OUTPUT_DIR}/smoke-report.json" \
  SMOKE_SKIP_WEB="${SMOKE_SKIP_WEB}" node scripts/verify-smoke-core.mjs

if [[ "${RUN_UNIVER_UI_SMOKE}" == "true" ]]; then
  echo ""
  echo "Running Univer UI smoke..."
  API_BASE="${API_BASE}" WEB_BASE="${WEB_BASE}" OUTPUT_DIR="${OUTPUT_DIR}" AUTO_START=false \
    node scripts/verify-univer-ui-smoke.mjs
fi

if [[ "${RUN_PLM_UI_REGRESSION}" == "true" ]]; then
  echo ""
  echo "Running PLM UI regression..."
  API_BASE="${API_BASE}" WEB_BASE="${WEB_BASE}" OUTPUT_DIR="${OUTPUT_DIR}" AUTO_START=false \
    bash scripts/verify-plm-ui-regression.sh
fi

if [[ "${RUN_PLM_UI_READONLY}" == "true" ]]; then
  echo ""
  echo "Running PLM UI readonly regression..."
  if [[ -z "${PLM_BOM_TOOLS_JSON}" && -f "${PLM_BOM_TOOLS_LATEST}" ]]; then
    PLM_BOM_TOOLS_JSON="${PLM_BOM_TOOLS_LATEST}"
  fi
  if [[ -z "${PLM_BOM_TOOLS_JSON}" ]]; then
    PLM_BOM_TOOLS_JSON=$(ls -t artifacts/plm-bom-tools-*.json 2>/dev/null | head -n1 || true)
  fi
  if [[ -z "${PLM_BOM_TOOLS_JSON}" ]]; then
    echo "Missing PLM_BOM_TOOLS_JSON and no artifacts/plm-bom-tools-*.json found." >&2
    exit 1
  fi
  API_BASE="${API_BASE}" WEB_BASE="${WEB_BASE}" OUTPUT_DIR="${OUTPUT_DIR}" PLM_BOM_TOOLS_JSON="${PLM_BOM_TOOLS_JSON}" AUTO_START=false \
    bash scripts/verify-plm-ui-readonly.sh
fi
