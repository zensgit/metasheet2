#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

API_BASE="${API_BASE:-http://127.0.0.1:7778}"
WEB_BASE="${WEB_BASE:-http://127.0.0.1:8899}"
WEB_HOST="${WEB_HOST:-127.0.0.1}"
WEB_PORT="${WEB_PORT:-}"
BACKEND_MODE="${BACKEND_MODE:-core}"
FORCE_WEB="${FORCE_WEB:-false}"

OUTPUT_DIR="${OUTPUT_DIR:-artifacts/univer-poc}"
BACKEND_LOG="${BACKEND_LOG:-$OUTPUT_DIR/backend.log}"
WEB_LOG="${WEB_LOG:-$OUTPUT_DIR/web.log}"
BACKEND_PID_FILE="${BACKEND_PID_FILE:-$OUTPUT_DIR/backend.pid}"
WEB_PID_FILE="${WEB_PID_FILE:-$OUTPUT_DIR/web.pid}"

PLM_ENV="${PLM_ENV:-}"
PLM_BASE_URL="${PLM_BASE_URL:-http://127.0.0.1:7910}"
PLM_TENANT_ID="${PLM_TENANT_ID:-tenant-1}"
PLM_ORG_ID="${PLM_ORG_ID:-org-1}"
PLM_USERNAME="${PLM_USERNAME:-admin}"
PLM_PASSWORD="${PLM_PASSWORD:-admin}"
PLM_ITEM_TYPE="${PLM_ITEM_TYPE:-Part}"

RBAC_BYPASS="${RBAC_BYPASS:-true}"
JWT_SECRET_VALUE="${JWT_SECRET:-fallback-development-secret-change-in-production}"
SMOKE_DATABASE_URL="${SMOKE_DATABASE_URL:-postgresql://metasheet:metasheet@127.0.0.1:5435/metasheet}"
DISABLE_EVENT_BUS="${DISABLE_EVENT_BUS:-true}"
SKIP_PLUGINS="${SKIP_PLUGINS:-true}"

mkdir -p "$OUTPUT_DIR"

if [[ -z "$WEB_PORT" ]]; then
  WEB_PORT="$(python3 - <<'PY' "$WEB_BASE"
from urllib.parse import urlparse
import sys
url = urlparse(sys.argv[1])
print(url.port or 8899)
PY
  )"
fi

PORT="$(python3 - <<'PY'
from urllib.parse import urlparse
import os
u=urlparse(os.environ.get("API_BASE","http://127.0.0.1:7778"))
print(u.port or 7778)
PY
)"

ensure_yuantus() {
  if [[ "$PLM_ENV" == "yuantus" ]]; then
    bash scripts/start-yuantus-plm.sh
  fi
}

start_backend() {
  if [[ "$BACKEND_MODE" == "mock" ]]; then
    echo "BACKEND_MODE=mock: skipping core-backend startup."
    return 0
  fi
  echo "Starting core-backend..."
  PORT="$PORT" DATABASE_URL="$SMOKE_DATABASE_URL" RBAC_BYPASS="$RBAC_BYPASS" \
    JWT_SECRET="$JWT_SECRET_VALUE" DISABLE_EVENT_BUS="$DISABLE_EVENT_BUS" SKIP_PLUGINS="$SKIP_PLUGINS" \
    PLM_BASE_URL="$PLM_BASE_URL" PLM_API_MODE="yuantus" PLM_TENANT_ID="$PLM_TENANT_ID" PLM_ORG_ID="$PLM_ORG_ID" \
    PLM_USERNAME="$PLM_USERNAME" PLM_PASSWORD="$PLM_PASSWORD" PLM_ITEM_TYPE="$PLM_ITEM_TYPE" \
    pnpm --filter @metasheet/core-backend dev:core > "$BACKEND_LOG" 2>&1 &
  echo $! > "$BACKEND_PID_FILE"

  for _ in {1..30}; do
    if curl -fsS "${API_BASE}/health" >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done
  echo "Backend failed to start (see $BACKEND_LOG)" >&2
  exit 1
}

start_web() {
  echo "Starting web dev server..."
  VITE_API_BASE="$API_BASE" VITE_PORT="$WEB_PORT" pnpm --filter @metasheet/web dev -- --host "$WEB_HOST" --port "$WEB_PORT" \
    > "$WEB_LOG" 2>&1 &
  echo $! > "$WEB_PID_FILE"

  for _ in {1..30}; do
    if curl -fsS "${WEB_BASE}/" >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done
  echo "Web server failed to start (see $WEB_LOG)" >&2
  exit 1
}

ensure_yuantus

if ! curl -fsS "${API_BASE}/health" >/dev/null 2>&1; then
  start_backend
else
  echo "Core-backend already running at ${API_BASE}"
fi

if [[ "$FORCE_WEB" == "true" ]]; then
  start_web
elif ! curl -fsS "${WEB_BASE}/" >/dev/null 2>&1; then
  start_web
else
  echo "Web already running at ${WEB_BASE}"
fi

echo "MetaSheet POC ready:"
echo "  - API: ${API_BASE}"
echo "  - Web: ${WEB_BASE}"
