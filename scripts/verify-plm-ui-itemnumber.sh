#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

API_BASE="${API_BASE:-http://127.0.0.1:7778}"
WEB_BASE="${WEB_BASE:-http://127.0.0.1:8899}"
UI_BASE="${UI_BASE:-${WEB_BASE}/plm}"
WEB_HOST="${WEB_HOST:-127.0.0.1}"
WEB_PORT="${WEB_PORT:-}"
FORCE_WEB="${FORCE_WEB:-false}"
AUTO_START="${AUTO_START:-false}"
HEADLESS="${HEADLESS:-true}"
OUTPUT_DIR="${OUTPUT_DIR:-artifacts}"
REPORT_DIR="${REPORT_DIR:-docs}"
STAMP="${STAMP:-$(date +%Y%m%d_%H%M%S)}"

PLM_BASE_URL="${PLM_BASE_URL:-http://127.0.0.1:7910}"
PLM_TENANT_ID="${PLM_TENANT_ID:-tenant-1}"
PLM_ORG_ID="${PLM_ORG_ID:-org-1}"
PLM_USERNAME="${PLM_USERNAME:-admin}"
PLM_PASSWORD="${PLM_PASSWORD:-admin}"
PLM_ITEM_TYPE="${PLM_ITEM_TYPE:-Part}"
PLM_ITEM_NUMBER="${PLM_ITEM_NUMBER:-}"
PLM_ITEM_ID="${PLM_ITEM_ID:-}"
PLM_CLEANUP="${PLM_CLEANUP:-false}"
PLM_ITEM_CREATED="false"
PLM_API_TOKEN="${PLM_API_TOKEN:-${PLM_AUTH_TOKEN:-${PLM_TOKEN:-}}}"

RBAC_BYPASS="${RBAC_BYPASS:-true}"
JWT_SECRET_VALUE="${JWT_SECRET:-fallback-development-secret-change-in-production}"
SMOKE_DATABASE_URL="${SMOKE_DATABASE_URL:-postgresql://metasheet:metasheet@127.0.0.1:5435/metasheet}"
TSX_BIN="${TSX_BIN:-$ROOT_DIR/node_modules/.bin/tsx}"

mkdir -p "$OUTPUT_DIR" "$REPORT_DIR"
SCREENSHOT_PATH="$OUTPUT_DIR/plm-ui-itemnumber-${STAMP}.png"
RESULT_PATH="$OUTPUT_DIR/plm-ui-itemnumber-${STAMP}.json"
REPORT_PATH="$REPORT_DIR/verification-plm-ui-itemnumber-${STAMP}.md"

if [[ -z "$WEB_PORT" ]]; then
  WEB_PORT="$(python3 - <<'PY' "$WEB_BASE"
from urllib.parse import urlparse
import sys
url = urlparse(sys.argv[1])
print(url.port or 8899)
PY
)"
fi

if [[ ! -x "$TSX_BIN" ]]; then
  TSX_BIN="tsx"
fi
if ! command -v "$TSX_BIN" >/dev/null 2>&1; then
  echo "tsx binary not found. Set TSX_BIN to the local tsx path." >&2
  exit 1
fi

start_backend() {
  echo "Starting core-backend..."
  PORT="$(python3 - <<'PY'
from urllib.parse import urlparse
import os
u=urlparse(os.environ.get("API_BASE","http://127.0.0.1:7778"))
print(u.port or 7778)
PY
  )"
  PORT="$PORT" DATABASE_URL="$SMOKE_DATABASE_URL" RBAC_BYPASS="$RBAC_BYPASS" JWT_SECRET="$JWT_SECRET_VALUE" \
    PLM_BASE_URL="$PLM_BASE_URL" PLM_API_MODE="yuantus" PLM_TENANT_ID="$PLM_TENANT_ID" PLM_ORG_ID="$PLM_ORG_ID" \
    PLM_USERNAME="$PLM_USERNAME" PLM_PASSWORD="$PLM_PASSWORD" PLM_ITEM_TYPE="$PLM_ITEM_TYPE" \
    pnpm --filter @metasheet/core-backend dev:core > "$OUTPUT_DIR/plm-ui-itemnumber-backend.log" 2>&1 &
  BACK_PID=$!

  for _ in {1..30}; do
    if curl -fsS "${API_BASE}/health" >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done
  echo "Backend failed to start (see $OUTPUT_DIR/plm-ui-itemnumber-backend.log)" >&2
  exit 1
}

start_web() {
  echo "Starting web dev server..."
  VITE_API_BASE="$API_BASE" VITE_PORT="$WEB_PORT" pnpm --filter @metasheet/web dev -- --host "$WEB_HOST" \
    > "$OUTPUT_DIR/plm-ui-itemnumber-web.log" 2>&1 &
  WEB_PID=$!

  for _ in {1..30}; do
    if curl -fsS "${WEB_BASE}/" >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done
  echo "Web server failed to start (see $OUTPUT_DIR/plm-ui-itemnumber-web.log)" >&2
  exit 1
}

BACK_PID=""
WEB_PID=""

if ! curl -fsS "${API_BASE}/health" >/dev/null 2>&1; then
  if [[ "$AUTO_START" != "true" ]]; then
    echo "Core backend not running at ${API_BASE}." >&2
    echo "Start it or re-run with AUTO_START=true." >&2
    exit 1
  fi
  start_backend
fi

if [[ "$FORCE_WEB" == "true" ]]; then
  start_web
elif ! curl -fsS "${WEB_BASE}/" >/dev/null 2>&1; then
  if [[ "$AUTO_START" != "true" ]]; then
    echo "Web UI not running at ${WEB_BASE}." >&2
    echo "Start it or re-run with AUTO_START=true." >&2
    exit 1
  fi
  start_web
fi

cleanup() {
  if [[ -n "$WEB_PID" ]]; then
    kill "$WEB_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "$BACK_PID" ]]; then
    kill "$BACK_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

METASHEET_TOKEN="${METASHEET_AUTH_TOKEN:-}"
if [[ -z "$METASHEET_TOKEN" ]]; then
  METASHEET_TOKEN=$(curl -sS "${API_BASE}/api/auth/dev-token" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' || true)
fi

if [[ -z "$METASHEET_TOKEN" ]]; then
  token_json="$OUTPUT_DIR/plm-ui-itemnumber-token.json"
  token_err="$OUTPUT_DIR/plm-ui-itemnumber-token.err"
  JWT_SECRET="$JWT_SECRET_VALUE" "$TSX_BIN" packages/core-backend/scripts/gen-dev-token.ts \
    --user admin --roles admin --expiresIn 1h >"$token_json" 2>"$token_err" || true
  if [[ ! -s "$token_json" ]]; then
    echo "Failed to generate MetaSheet auth token (see $token_err)." >&2
    exit 1
  fi
  METASHEET_TOKEN=$(python3 - <<'PY' "$token_json"
import json,sys
with open(sys.argv[1], encoding="utf-8") as f:
    print(json.load(f).get("token",""))
PY
  )
fi

if [[ -z "$METASHEET_TOKEN" ]]; then
  echo "Failed to generate MetaSheet auth token." >&2
  exit 1
fi

PLM_TOKEN="$PLM_API_TOKEN"
if [[ -z "$PLM_TOKEN" ]]; then
  PLM_TOKEN=$(curl -s -X POST "${PLM_BASE_URL}/api/v1/auth/login" \
    -H 'Content-Type: application/json' \
    -H "x-tenant-id: ${PLM_TENANT_ID}" \
    -H "x-org-id: ${PLM_ORG_ID}" \
    -d "{\"tenant_id\":\"${PLM_TENANT_ID}\",\"org_id\":\"${PLM_ORG_ID}\",\"username\":\"${PLM_USERNAME}\",\"password\":\"${PLM_PASSWORD}\"}" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access_token",""))' || true)
fi

if [[ -z "$PLM_TOKEN" ]]; then
  echo "Failed to obtain PLM token." >&2
  exit 1
fi

delete_item() {
  local item_id="$1"
  if [[ -z "$item_id" ]]; then
    return 0
  fi
  curl -s -X POST "${PLM_BASE_URL}/api/v1/aml/apply" \
    -H "Authorization: Bearer ${PLM_TOKEN}" \
    -H "x-tenant-id: ${PLM_TENANT_ID}" \
    -H "x-org-id: ${PLM_ORG_ID}" \
    -H 'Content-Type: application/json' \
    -d "{\"type\":\"${PLM_ITEM_TYPE}\",\"action\":\"delete\",\"id\":\"${item_id}\"}" >/dev/null || true
}

if [[ -z "$PLM_ITEM_NUMBER" || -z "$PLM_ITEM_ID" ]]; then
  PLM_ITEM_NUMBER="${PLM_ITEM_NUMBER:-MS-UI-${STAMP}}"
  CREATE_RESP=$(curl -s -X POST "${PLM_BASE_URL}/api/v1/aml/apply" \
    -H "Authorization: Bearer ${PLM_TOKEN}" \
    -H "x-tenant-id: ${PLM_TENANT_ID}" \
    -H "x-org-id: ${PLM_ORG_ID}" \
    -H 'Content-Type: application/json' \
    -d "{\"type\":\"${PLM_ITEM_TYPE}\",\"action\":\"add\",\"properties\":{\"item_number\":\"${PLM_ITEM_NUMBER}\",\"name\":\"UI Test Part\",\"description\":\"MetaSheet UI test part\"}}")
  PLM_ITEM_ID=$(python3 - <<PY
import json
payload=json.loads('''$CREATE_RESP''')
print(payload.get('id',''))
PY
  )
  PLM_ITEM_CREATED="true"
fi

if [[ -z "$PLM_ITEM_NUMBER" ]]; then
  echo "Missing PLM_ITEM_NUMBER; unable to continue." >&2
  exit 1
fi

cat > /tmp/plm_ui_itemnumber.js <<'JS_EOF'
const { chromium } = require('@playwright/test');
const fs = require('fs');

const metaToken = process.env.METASHEET_TOKEN;
const plmToken = process.env.PLM_TOKEN || '';
const itemNumber = process.env.PLM_ITEM_NUMBER;
const expectedId = process.env.PLM_ITEM_ID || '';
const url = process.env.UI_BASE || 'http://localhost:8899/plm';
const screenshotPath = process.env.SCREENSHOT_PATH;
const resultPath = process.env.RESULT_PATH;
const headless = process.env.HEADLESS !== 'false';

if (!metaToken || !itemNumber || !screenshotPath || !resultPath) {
  console.error('Missing required inputs.');
  process.exit(1);
}

(async () => {
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.addInitScript((authToken, plmTokenValue) => {
    localStorage.setItem('auth_token', authToken);
    if (plmTokenValue) {
      localStorage.setItem('plm_token', plmTokenValue);
    }
  }, metaToken, plmToken);

  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });

  await page.locator('#plm-item-number').fill(itemNumber);
  await page.getByRole('button', { name: '加载产品' }).click();
  await page.waitForFunction(() => {
    const input = document.querySelector('#plm-product-id');
    return input && input.value && input.value.length > 0;
  }, null, { timeout: 60000 });

  const productId = await page.$eval('#plm-product-id', (el) => el.value);

  const bomButton = page.getByRole('button', { name: '刷新 BOM' });
  if (await bomButton.isEnabled()) {
    await bomButton.click();
  }
  await page.waitForTimeout(1000);

  await page.screenshot({ path: screenshotPath, fullPage: true });

  fs.writeFileSync(resultPath, JSON.stringify({ itemNumber, productId, expectedId }, null, 2));
  await browser.close();
})();
JS_EOF

NODE_PATH="$ROOT_DIR/node_modules" \
METASHEET_TOKEN="$METASHEET_TOKEN" \
PLM_TOKEN="$PLM_TOKEN" \
PLM_ITEM_NUMBER="$PLM_ITEM_NUMBER" \
PLM_ITEM_ID="$PLM_ITEM_ID" \
UI_BASE="$UI_BASE" \
SCREENSHOT_PATH="$SCREENSHOT_PATH" \
RESULT_PATH="$RESULT_PATH" \
HEADLESS="$HEADLESS" \
node /tmp/plm_ui_itemnumber.js

cat > "$REPORT_PATH" <<REPORT_EOF
# Verification: PLM UI Item Number Load - ${STAMP}

## Goal
Verify that the PLM UI can load a product using only the item number and resolve the product ID.

## Environment
- UI: ${UI_BASE}
- API: ${API_BASE}
- PLM: ${PLM_BASE_URL}
- PLM_TENANT_ID: ${PLM_TENANT_ID}
- PLM_ORG_ID: ${PLM_ORG_ID}

## Data
- Item number: ${PLM_ITEM_NUMBER}
- Expected product ID: ${PLM_ITEM_ID:-n/a}

## Result
- Product ID resolved and populated in the form.
- Screenshot: ${SCREENSHOT_PATH}
- Result JSON: ${RESULT_PATH}
REPORT_EOF

if [[ "$PLM_CLEANUP" == "true" && "$PLM_ITEM_CREATED" == "true" ]]; then
  delete_item "$PLM_ITEM_ID"
fi

printf "Report: %s\n" "$REPORT_PATH"
printf "Screenshot: %s\n" "$SCREENSHOT_PATH"
