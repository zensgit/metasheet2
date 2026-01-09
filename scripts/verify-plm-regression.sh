#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

API_BASE="${API_BASE:-http://127.0.0.1:7778}"
PLM_BASE_URL="${PLM_BASE_URL:-http://127.0.0.1:7910}"
PLM_TENANT_ID="${PLM_TENANT_ID:-tenant-1}"
PLM_ORG_ID="${PLM_ORG_ID:-org-1}"
PLM_USERNAME="${PLM_USERNAME:-admin}"
PLM_PASSWORD="${PLM_PASSWORD:-admin}"
SMOKE_DATABASE_URL="${SMOKE_DATABASE_URL:-postgresql://metasheet:metasheet@127.0.0.1:5435/metasheet}"
WEB_BASE="${WEB_BASE:-http://127.0.0.1:8899}"
WEB_PORT="${WEB_PORT:-}"
WEB_HOST="${WEB_HOST:-}"
PLM_SEED_ENV="${PLM_SEED_ENV:-local}"
RBAC_BYPASS="${RBAC_BYPASS:-true}"
JWT_SECRET_VALUE="${JWT_SECRET:-fallback-development-secret-change-in-production}"
OUTPUT_DIR="${OUTPUT_DIR:-artifacts}"
REPORT_DIR="${REPORT_DIR:-docs}"
STAMP="${STAMP:-$(date +%Y%m%d_%H%M%S)}"
REPORT_PATH="${REPORT_PATH:-$REPORT_DIR/verification-plm-regression-${STAMP}.md}"
AUTO_START="${AUTO_START:-true}"
FORCE_WEB="${FORCE_WEB:-false}"

mkdir -p "$OUTPUT_DIR" "$REPORT_DIR"

log() {
  printf "[plm-regression] %s\n" "$*"
}

BACK_PID=""
WEB_PID=""

start_backend() {
  log "Starting core-backend..."
  PORT="$(python3 - <<'PY'
from urllib.parse import urlparse
import os
u=urlparse(os.environ.get("API_BASE","http://127.0.0.1:7778"))
print(u.port or 7778)
PY
)"
  PORT="$PORT" DATABASE_URL="$SMOKE_DATABASE_URL" RBAC_BYPASS="$RBAC_BYPASS" JWT_SECRET="$JWT_SECRET_VALUE" \
    PLM_BASE_URL="$PLM_BASE_URL" PLM_API_MODE="yuantus" PLM_TENANT_ID="$PLM_TENANT_ID" PLM_ORG_ID="$PLM_ORG_ID" \
    PLM_USERNAME="$PLM_USERNAME" PLM_PASSWORD="$PLM_PASSWORD" \
    pnpm --filter @metasheet/core-backend dev:core > "$OUTPUT_DIR/plm-regression-backend.log" 2>&1 &
  BACK_PID=$!

  for _ in {1..30}; do
    if curl -fsS "${API_BASE}/health" >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done
  echo "Backend failed to start (see $OUTPUT_DIR/plm-regression-backend.log)" >&2
  exit 1
}

start_web() {
  log "Starting web dev server..."
  if [[ -z "$WEB_PORT" ]]; then
    WEB_PORT="$(python3 - <<'PY' "$WEB_BASE"
from urllib.parse import urlparse
import sys
url = urlparse(sys.argv[1])
print(url.port or 8899)
PY
)"
  fi
  if [[ -z "$WEB_HOST" ]]; then
    WEB_HOST="127.0.0.1"
  fi
  VITE_API_BASE="$API_BASE" VITE_PORT="$WEB_PORT" pnpm --filter @metasheet/web dev -- --host "$WEB_HOST" \
    > "$OUTPUT_DIR/plm-regression-web.log" 2>&1 &
  WEB_PID=$!

  for _ in {1..30}; do
    if curl -fsS "${WEB_BASE}/" >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done
  echo "Web server failed to start (see $OUTPUT_DIR/plm-regression-web.log)" >&2
  exit 1
}

ensure_backend() {
  if curl -fsS "${API_BASE}/health" >/dev/null 2>&1; then
    return
  fi
  if [[ "$AUTO_START" != "true" ]]; then
    echo "Core backend not running at ${API_BASE}." >&2
    echo "Start it or re-run with AUTO_START=true." >&2
    exit 1
  fi
  start_backend
}

ensure_web() {
  if curl -fsS "${WEB_BASE}/" >/dev/null 2>&1; then
    return
  fi
  if [[ "$AUTO_START" != "true" ]]; then
    echo "Web UI not running at ${WEB_BASE}." >&2
    echo "Start it or re-run with AUTO_START=true." >&2
    exit 1
  fi
  start_web
}

cleanup() {
  if [[ -n "$WEB_PID" ]]; then
    kill "$WEB_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "$BACK_PID" ]]; then
    kill "$BACK_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

log "Seeding PLM substitutes fixture..."
ensure_backend
seed_output=$(AUTO_START="$AUTO_START" OUTPUT_DIR="$OUTPUT_DIR" REPORT_DIR="$REPORT_DIR" STAMP="$STAMP" \
  PLM_BASE_URL="$PLM_BASE_URL" PLM_TENANT_ID="$PLM_TENANT_ID" PLM_ORG_ID="$PLM_ORG_ID" \
  PLM_USERNAME="$PLM_USERNAME" PLM_PASSWORD="$PLM_PASSWORD" PLM_SEED_ENV="$PLM_SEED_ENV" \
  bash scripts/seed-plm-substitutes-fixture.sh)
fixture_json=$(echo "$seed_output" | awk -F': ' '/^Fixture:/{print $2}' | tail -n1)
seed_report=$(echo "$seed_output" | awk -F': ' '/^Report:/{print $2}' | tail -n1)

log "Running PLM BOM tools verification..."
bom_output=$(AUTO_START="false" OUTPUT_DIR="$OUTPUT_DIR" STAMP="$STAMP" \
  API_BASE="$API_BASE" PLM_BASE_URL="$PLM_BASE_URL" PLM_TENANT_ID="$PLM_TENANT_ID" PLM_ORG_ID="$PLM_ORG_ID" \
  PLM_USERNAME="$PLM_USERNAME" PLM_PASSWORD="$PLM_PASSWORD" SMOKE_DATABASE_URL="$SMOKE_DATABASE_URL" \
  bash scripts/verify-plm-bom-tools.sh)
bom_report=$(echo "$bom_output" | tail -n1)

log "Running PLM substitutes mutation verification..."
subs_output=$(AUTO_START="false" OUTPUT_DIR="$OUTPUT_DIR" REPORT_DIR="$REPORT_DIR" STAMP="$STAMP" \
  API_BASE="$API_BASE" PLM_BASE_URL="$PLM_BASE_URL" PLM_TENANT_ID="$PLM_TENANT_ID" PLM_ORG_ID="$PLM_ORG_ID" \
  PLM_USERNAME="$PLM_USERNAME" PLM_PASSWORD="$PLM_PASSWORD" SMOKE_DATABASE_URL="$SMOKE_DATABASE_URL" \
  bash scripts/verify-plm-substitutes-mutation.sh)
subs_report=$(echo "$subs_output" | awk -F': ' '/^Report:/{print $2}' | tail -n1)

log "Running PLM UI substitutes mutation verification..."
ensure_web
ui_output=$(AUTO_START="false" FORCE_WEB="false" OUTPUT_DIR="$OUTPUT_DIR" REPORT_DIR="$REPORT_DIR" \
  STAMP="$STAMP" PLM_SUBS_FIXTURE_JSON="$fixture_json" API_BASE="$API_BASE" WEB_BASE="$WEB_BASE" \
  WEB_PORT="$WEB_PORT" WEB_HOST="$WEB_HOST" PLM_BASE_URL="$PLM_BASE_URL" PLM_TENANT_ID="$PLM_TENANT_ID" \
  PLM_ORG_ID="$PLM_ORG_ID" PLM_USERNAME="$PLM_USERNAME" PLM_PASSWORD="$PLM_PASSWORD" \
  SMOKE_DATABASE_URL="$SMOKE_DATABASE_URL" \
  bash scripts/verify-plm-ui-substitutes-mutation.sh)
ui_report=$(echo "$ui_output" | awk -F': ' '/^Report:/{print $2}' | tail -n1)
ui_screenshot=$(echo "$ui_output" | awk -F': ' '/^Screenshot:/{print $2}' | tail -n1)

cat > "$REPORT_PATH" <<REPORT_EOF
# Verification: PLM Regression - ${STAMP}

## Environment
- MetaSheet API: ${API_BASE}
- PLM Base URL: ${PLM_BASE_URL}
- PLM Seed Env: ${PLM_SEED_ENV}

## Steps
1. Seed substitutes fixture
2. BOM tools verification
3. Substitutes mutation verification
4. UI substitutes mutation verification

## Artifacts
- Fixture JSON: ${fixture_json}
- Fixture report: ${seed_report}
- BOM tools report: ${bom_report}
- Substitutes mutation report: ${subs_report}
- UI substitutes report: ${ui_report}
- UI substitutes screenshot: ${ui_screenshot}

Status: PASS
REPORT_EOF

echo "Report: ${REPORT_PATH}"
