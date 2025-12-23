#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

API_BASE="${API_BASE:-http://127.0.0.1:7778}"
WEB_BASE="${WEB_BASE:-http://127.0.0.1:8899}"
SMOKE_DATABASE_URL="${SMOKE_DATABASE_URL:-postgresql://metasheet:metasheet@127.0.0.1:5435/metasheet}"
RBAC_BYPASS="${RBAC_BYPASS:-true}"
SMOKE_SKIP_WEB="${SMOKE_SKIP_WEB:-false}"
OUTPUT_DIR="${OUTPUT_DIR:-artifacts/smoke}"

mkdir -p "$OUTPUT_DIR"

echo "== MetaSheet Smoke Verification =="
echo "- API_BASE: ${API_BASE}"
echo "- WEB_BASE: ${WEB_BASE}"
echo "- SMOKE_DATABASE_URL: ${SMOKE_DATABASE_URL}"
echo "- RBAC_BYPASS: ${RBAC_BYPASS}"
echo "- SMOKE_SKIP_WEB: ${SMOKE_SKIP_WEB}"
echo "- OUTPUT_DIR: ${OUTPUT_DIR}"
echo ""

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm not found. Please install pnpm first."
  exit 1
fi

if ! curl -fsS "${API_BASE}/health" >/dev/null 2>&1; then
  echo "[1/3] Preparing database..."
  DATABASE_URL="${SMOKE_DATABASE_URL}" pnpm --filter @metasheet/core-backend migrate >/dev/null

  echo "[2/3] Starting backend..."
  PORT="$(python3 - <<'PY'
from urllib.parse import urlparse
import os
u=urlparse(os.environ.get("API_BASE","http://127.0.0.1:7778"))
print(u.port or 7778)
PY
)"
  PORT="${PORT}" DATABASE_URL="${SMOKE_DATABASE_URL}" DISABLE_WORKFLOW=true DISABLE_EVENT_BUS=true SKIP_PLUGINS=true RBAC_BYPASS="${RBAC_BYPASS}" \
    pnpm --filter @metasheet/core-backend dev:core > "${OUTPUT_DIR}/backend.log" 2>&1 &
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
