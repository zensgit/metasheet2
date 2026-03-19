#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

timestamp="$(date +%Y%m%d-%H%M%S)"
OUTPUT_ROOT="${OUTPUT_ROOT:-output/playwright/multitable-pilot-local/${timestamp}}"
API_BASE="${API_BASE:-http://127.0.0.1:7778}"
WEB_BASE="${WEB_BASE:-http://127.0.0.1:8899}"
PILOT_DATABASE_URL="${PILOT_DATABASE_URL:-postgresql://metasheet:metasheet@127.0.0.1:5435/metasheet}"
RBAC_TOKEN_TRUST="${RBAC_TOKEN_TRUST:-true}"
ENSURE_PLAYWRIGHT="${ENSURE_PLAYWRIGHT:-true}"
HEADLESS="${HEADLESS:-true}"
TIMEOUT_MS="${TIMEOUT_MS:-30000}"

mkdir -p "$OUTPUT_ROOT"
BACK_PID=""
WEB_PID=""

function info() {
  echo "[multitable-pilot-local] $*" >&2
}

function parse_port() {
  python3 - <<'PY' "$1"
from urllib.parse import urlparse
import sys
url = urlparse(sys.argv[1])
if url.port:
    print(url.port)
elif url.scheme == 'https':
    print(443)
else:
    print(80)
PY
}

function wait_for_url() {
  local url="$1"
  local name="$2"
  for _ in $(seq 1 45); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "${name} failed to become ready: ${url}" >&2
  return 1
}

function cleanup() {
  if [[ -n "$BACK_PID" ]]; then
    kill "$BACK_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "$WEB_PID" ]]; then
    kill "$WEB_PID" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT INT TERM

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm not found. Please install pnpm first." >&2
  exit 1
fi

if [[ "$ENSURE_PLAYWRIGHT" == "true" ]]; then
  info "Ensuring Playwright Chromium is installed"
  npx playwright install chromium >"${OUTPUT_ROOT}/playwright-install.log" 2>&1
fi

if ! curl -fsS "${API_BASE}/health" >/dev/null 2>&1; then
  info "Preparing database"
  DATABASE_URL="${PILOT_DATABASE_URL}" pnpm --filter @metasheet/core-backend migrate >"${OUTPUT_ROOT}/backend-migrate.log" 2>&1

  info "Starting backend"
  API_PORT="$(parse_port "${API_BASE}")"
  PORT="${API_PORT}" DATABASE_URL="${PILOT_DATABASE_URL}" RBAC_TOKEN_TRUST="${RBAC_TOKEN_TRUST}" \
    pnpm --filter @metasheet/core-backend dev >"${OUTPUT_ROOT}/backend.log" 2>&1 &
  BACK_PID=$!
  wait_for_url "${API_BASE}/health" "backend"
else
  info "Backend already running at ${API_BASE}"
fi

if ! curl -fsS "${WEB_BASE}/" >/dev/null 2>&1; then
  info "Starting web"
  WEB_PORT="$(parse_port "${WEB_BASE}")"
  pnpm --filter @metasheet/web dev -- --host 127.0.0.1 --port "${WEB_PORT}" >"${OUTPUT_ROOT}/web.log" 2>&1 &
  WEB_PID=$!
  wait_for_url "${WEB_BASE}/" "web"
else
  info "Web already running at ${WEB_BASE}"
fi

info "Running multitable pilot smoke"
API_BASE="${API_BASE}" \
WEB_BASE="${WEB_BASE}" \
OUTPUT_DIR="${OUTPUT_ROOT}" \
REPORT_JSON="${OUTPUT_ROOT}/report.json" \
HEADLESS="${HEADLESS}" \
TIMEOUT_MS="${TIMEOUT_MS}" \
node scripts/verify-multitable-live-smoke.mjs

info "PASS: multitable pilot smoke completed"
info "Artifacts: ${OUTPUT_ROOT}"
