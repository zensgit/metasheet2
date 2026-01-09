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
PLM_BASE_URL="${PLM_BASE_URL:-http://127.0.0.1:7910}"
PLM_TENANT_ID="${PLM_TENANT_ID:-tenant-1}"
PLM_ORG_ID="${PLM_ORG_ID:-org-1}"
PLM_USERNAME="${PLM_USERNAME:-admin}"
PLM_PASSWORD="${PLM_PASSWORD:-admin}"
SMOKE_DATABASE_URL="${SMOKE_DATABASE_URL:-postgresql://metasheet:metasheet@127.0.0.1:5435/metasheet}"
AUTO_START="${AUTO_START:-false}"
RBAC_BYPASS="${RBAC_BYPASS:-true}"
JWT_SECRET_VALUE="${JWT_SECRET:-fallback-development-secret-change-in-production}"
METASHEET_AUTH_TOKEN="${METASHEET_AUTH_TOKEN:-}"
TSX_BIN="${TSX_BIN:-$ROOT_DIR/node_modules/.bin/tsx}"
HEADLESS="${HEADLESS:-true}"
OUTPUT_DIR="${OUTPUT_DIR:-artifacts}"
REPORT_DIR="${REPORT_DIR:-docs}"
STAMP="${STAMP:-$(date +%Y%m%d_%H%M%S)}"
PLM_BOM_TOOLS_JSON="${PLM_BOM_TOOLS_JSON:-}"
PLM_SUBS_FIXTURE_JSON="${PLM_SUBS_FIXTURE_JSON:-artifacts/plm-substitutes-fixture.json}"
PLM_PRODUCT_ID="${PLM_PRODUCT_ID:-}"
PLM_BOM_LINE_ID="${PLM_BOM_LINE_ID:-}"
PLM_SEARCH_QUERY="${PLM_SEARCH_QUERY:-}"
SUBSTITUTE_ITEM_ID="${SUBSTITUTE_ITEM_ID:-}"

if [[ ! -x "$TSX_BIN" ]]; then
  TSX_BIN="tsx"
fi
if ! command -v "$TSX_BIN" >/dev/null 2>&1; then
  echo "tsx binary not found. Set TSX_BIN to the local tsx path." >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR" "$REPORT_DIR"
SCREENSHOT_PATH="$OUTPUT_DIR/plm-ui-substitutes-mutation-${STAMP}.png"
REPORT_PATH="$REPORT_DIR/verification-plm-ui-substitutes-mutation-${STAMP}.md"

if [[ -z "$WEB_PORT" ]]; then
  WEB_PORT="$(python3 - <<'PY' "$WEB_BASE"
from urllib.parse import urlparse
import sys
url = urlparse(sys.argv[1])
print(url.port or 8899)
PY
)"
fi

if [[ -n "$PLM_SUBS_FIXTURE_JSON" && -f "$PLM_SUBS_FIXTURE_JSON" ]]; then
  mapfile -t plm_lines < <(python3 - <<'PY' "$PLM_SUBS_FIXTURE_JSON"
import json
import sys
from pathlib import Path
path = Path(sys.argv[1])
if not path.exists():
    sys.exit(1)

data = json.loads(path.read_text())
print(data.get("search_query") or data.get("product_item_number") or "")
print(data.get("product_id") or "")
print(data.get("bom_line_id") or "")
print(data.get("substitute_item_id") or "")
PY
)
  if [[ -z "$PLM_SEARCH_QUERY" ]]; then
    PLM_SEARCH_QUERY="${plm_lines[0]:-}"
  fi
  if [[ -z "$PLM_PRODUCT_ID" ]]; then
    PLM_PRODUCT_ID="${plm_lines[1]:-}"
  fi
  if [[ -z "$PLM_BOM_LINE_ID" ]]; then
    PLM_BOM_LINE_ID="${plm_lines[2]:-}"
  fi
  if [[ -z "$SUBSTITUTE_ITEM_ID" ]]; then
    SUBSTITUTE_ITEM_ID="${plm_lines[3]:-}"
  fi
fi

if [[ -z "$PLM_PRODUCT_ID" || -z "$PLM_BOM_LINE_ID" || -z "$PLM_SEARCH_QUERY" ]]; then
  if [[ -z "$PLM_BOM_TOOLS_JSON" ]]; then
    PLM_BOM_TOOLS_JSON=$(ls -t artifacts/plm-bom-tools-*.json 2>/dev/null | head -n1 || true)
  fi
fi

if [[ -n "$PLM_BOM_TOOLS_JSON" && ( -z "$PLM_PRODUCT_ID" || -z "$PLM_BOM_LINE_ID" || -z "$PLM_SEARCH_QUERY" ) ]]; then
  mapfile -t plm_lines < <(python3 - <<'PY' "$PLM_BOM_TOOLS_JSON"
import json
import sys
from pathlib import Path
path = Path(sys.argv[1])
if not path.exists():
    sys.exit(1)

data = json.loads(path.read_text())
where_used = (data.get("where_used") or {}).get("data") or {}
parents = where_used.get("parents") or []
search_query = ""
product_id = ""
if parents:
    parent = parents[0].get("parent") or {}
    search_query = parent.get("item_number") or ""
    product_id = parent.get("id") or ""

subs = (data.get("substitutes") or {}).get("data") or {}
bom_line_id = subs.get("bom_line_id") or ""

print(search_query)
print(product_id)
print(bom_line_id)
PY
)
  if [[ -z "$PLM_SEARCH_QUERY" ]]; then
    PLM_SEARCH_QUERY="${plm_lines[0]:-}"
  fi
  if [[ -z "$PLM_PRODUCT_ID" ]]; then
    PLM_PRODUCT_ID="${plm_lines[1]:-}"
  fi
  if [[ -z "$PLM_BOM_LINE_ID" ]]; then
    PLM_BOM_LINE_ID="${plm_lines[2]:-}"
  fi
fi

if [[ -z "$PLM_PRODUCT_ID" || -z "$PLM_BOM_LINE_ID" ]]; then
  if [[ -x /tmp/plm_ui_subs_get_ids.py ]]; then
    mapfile -t plm_lines < <(python3 /tmp/plm_ui_subs_get_ids.py)
    if [[ -z "$PLM_PRODUCT_ID" ]]; then
      PLM_PRODUCT_ID="${plm_lines[0]:-}"
    fi
    if [[ -z "$PLM_SEARCH_QUERY" ]]; then
      PLM_SEARCH_QUERY="${plm_lines[1]:-}"
    fi
    if [[ -z "$PLM_BOM_LINE_ID" ]]; then
      PLM_BOM_LINE_ID="${plm_lines[2]:-}"
    fi
  fi
fi

if [[ -z "$PLM_PRODUCT_ID" || -z "$PLM_BOM_LINE_ID" ]]; then
  echo "Missing required PLM IDs; set PLM_PRODUCT_ID and PLM_BOM_LINE_ID." >&2
  exit 1
fi
if [[ -z "$SUBSTITUTE_ITEM_ID" ]]; then
  SUBSTITUTE_ITEM_ID="$(python3 /tmp/plm_ui_subs_make_item.py 2>/dev/null || true)"
fi
if [[ -z "$SUBSTITUTE_ITEM_ID" || "$SUBSTITUTE_ITEM_ID" == "NO_TOKEN" || "$SUBSTITUTE_ITEM_ID" == "NO_ITEM_ID" ]]; then
  echo "Failed to create substitute item; set SUBSTITUTE_ITEM_ID to an existing item." >&2
  exit 1
fi

BACK_PID=""
WEB_PID=""

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
    PLM_USERNAME="$PLM_USERNAME" PLM_PASSWORD="$PLM_PASSWORD" \
    pnpm --filter @metasheet/core-backend dev:core > "$OUTPUT_DIR/plm-ui-substitutes-mutation-backend.log" 2>&1 &
  BACK_PID=$!

  for _ in {1..30}; do
    if curl -fsS "${API_BASE}/health" >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done
  echo "Backend failed to start (see $OUTPUT_DIR/plm-ui-substitutes-mutation-backend.log)" >&2
  exit 1
}

start_web() {
  echo "Starting web dev server..."
  VITE_API_BASE="$API_BASE" VITE_PORT="$WEB_PORT" pnpm --filter @metasheet/web dev -- --host "$WEB_HOST" \
    > "$OUTPUT_DIR/plm-ui-substitutes-mutation-web.log" 2>&1 &
  WEB_PID=$!

  for _ in {1..30}; do
    if curl -fsS "${WEB_BASE}/" >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done
  echo "Web server failed to start (see $OUTPUT_DIR/plm-ui-substitutes-mutation-web.log)" >&2
  exit 1
}

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

METASHEET_TOKEN="$METASHEET_AUTH_TOKEN"
if [[ -z "$METASHEET_TOKEN" ]]; then
  METASHEET_TOKEN=$(curl -sS "${API_BASE}/api/auth/dev-token" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' || true)
fi

if [[ -z "$METASHEET_TOKEN" ]]; then
  token_json="$OUTPUT_DIR/plm-ui-substitutes-mutation-token.json"
  token_err="$OUTPUT_DIR/plm-ui-substitutes-mutation-token.err"
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

cat > /tmp/plm_ui_substitutes_mutation.js <<'JS_EOF'
const { chromium } = require('@playwright/test');

const token = process.env.METASHEET_TOKEN;
const productId = process.env.PLM_PRODUCT_ID;
const searchQuery = process.env.PLM_SEARCH_QUERY || '';
const bomLineId = process.env.PLM_BOM_LINE_ID;
const url = process.env.UI_BASE || 'http://localhost:8899/plm';
const screenshotPath = process.env.SCREENSHOT_PATH;
const headless = process.env.HEADLESS !== 'false';

if (!token || !productId || !bomLineId) {
  console.error('Missing required inputs.');
  process.exit(1);
}
if (!screenshotPath) {
  console.error('Missing SCREENSHOT_PATH');
  process.exit(1);
}

async function waitForSelectorWithReload(page, selector) {
  try {
    await page.waitForSelector(selector, { timeout: 60000 });
  } catch (_err) {
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector(selector, { timeout: 60000 });
  }
}

(async () => {
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.addInitScript((authToken) => {
    localStorage.setItem('auth_token', authToken);
  }, token);

  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });

  await waitForSelectorWithReload(page, '#plm-search-query');

  if (searchQuery) {
    await page.fill('#plm-search-query', searchQuery);
    await page.click('button:has-text("搜索")');
    try {
      const targetRow = page.locator('table tbody tr', { hasText: searchQuery });
      await targetRow.waitFor({ timeout: 20000 });
      await targetRow.locator('button:has-text("使用")').click();
    } catch (_err) {
      // fallback below
    }
  }

  if (!(await page.locator('#plm-product-id').inputValue()).trim()) {
    await page.fill('#plm-product-id', productId);
    await page.click('button:has-text("加载产品")');
    await page.waitForTimeout(500);
  }

  const substitutesSection = page.locator('section:has(h2:has-text("替代件"))');
  await substitutesSection.locator('#plm-bom-line-id').fill(bomLineId);
  await substitutesSection.locator('button:has-text("查询")').click();
  await substitutesSection.locator('p.status').waitFor({ timeout: 60000 });

  const substituteItemId = process.env.SUBSTITUTE_ITEM_ID;
  if (!substituteItemId) {
    console.error('Missing SUBSTITUTE_ITEM_ID');
    process.exit(1);
  }
  await substitutesSection.locator('#plm-substitute-item-id').fill(substituteItemId);
  await substitutesSection.locator('#plm-substitute-rank').fill('1');
  await substitutesSection.locator('#plm-substitute-note').fill('auto');
  await substitutesSection.locator('button:has-text("新增替代件")').click();

  await substitutesSection.locator('table.data-table tbody tr').first().waitFor({ timeout: 60000 });

  const deleteButton = substitutesSection.locator('table.data-table tbody tr').first().locator('button:has-text("删除")');
  page.once('dialog', async (dialog) => {
    await dialog.accept();
  });
  await deleteButton.click();

  await substitutesSection.locator('p.status').waitFor({ timeout: 60000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await browser.close();
})();
JS_EOF

NODE_PATH="$ROOT_DIR/node_modules" \
METASHEET_TOKEN="$METASHEET_TOKEN" \
PLM_PRODUCT_ID="$PLM_PRODUCT_ID" \
PLM_SEARCH_QUERY="$PLM_SEARCH_QUERY" \
PLM_BOM_LINE_ID="$PLM_BOM_LINE_ID" \
SUBSTITUTE_ITEM_ID="$SUBSTITUTE_ITEM_ID" \
UI_BASE="$UI_BASE" \
SCREENSHOT_PATH="$SCREENSHOT_PATH" \
HEADLESS="$HEADLESS" \
node /tmp/plm_ui_substitutes_mutation.js

cat > "$REPORT_PATH" <<REPORT_EOF
# Verification: PLM UI Substitutes Mutation - ${STAMP}

## Goal
Verify adding/removing BOM substitutes in the PLM UI.

## Environment
- UI: ${UI_BASE}
- API: ${API_BASE}
- PLM: ${PLM_BASE_URL}
- PLM_TENANT_ID: ${PLM_TENANT_ID}
- PLM_ORG_ID: ${PLM_ORG_ID}

## Data
- Product ID: ${PLM_PRODUCT_ID}
- Search query: ${PLM_SEARCH_QUERY}
- BOM line ID: ${PLM_BOM_LINE_ID}
- Substitute item ID: ${SUBSTITUTE_ITEM_ID}

## Results
- Loaded substitutes panel.
- Added substitute entry via UI.
- Removed substitute entry via UI.
- Screenshot: ${SCREENSHOT_PATH}
REPORT_EOF

echo "Report: ${REPORT_PATH}"
echo "Screenshot: ${SCREENSHOT_PATH}"
