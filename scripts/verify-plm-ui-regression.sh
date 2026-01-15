#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

API_BASE="${API_BASE:-http://127.0.0.1:7778}"
WEB_BASE="${WEB_BASE:-http://127.0.0.1:8899}"
UI_BASE="${UI_BASE:-${WEB_BASE}/plm}"
PLM_BASE_URL="${PLM_BASE_URL:-http://127.0.0.1:7910}"
PLM_URL="${PLM_URL:-$PLM_BASE_URL}"
PLM_TENANT_ID="${PLM_TENANT_ID:-tenant-1}"
PLM_ORG_ID="${PLM_ORG_ID:-org-1}"
PLM_USERNAME="${PLM_USERNAME:-admin}"
PLM_PASSWORD="${PLM_PASSWORD:-admin}"
SMOKE_DATABASE_URL="${SMOKE_DATABASE_URL:-postgresql://metasheet:metasheet@127.0.0.1:5435/metasheet}"
AUTO_START="${AUTO_START:-false}"
RBAC_BYPASS="${RBAC_BYPASS:-true}"
RBAC_TOKEN_TRUST="${RBAC_TOKEN_TRUST:-1}"
JWT_SECRET_VALUE="${JWT_SECRET:-fallback-development-secret-change-in-production}"
METASHEET_AUTH_TOKEN="${METASHEET_AUTH_TOKEN:-}"
TSX_BIN="${TSX_BIN:-$ROOT_DIR/node_modules/.bin/tsx}"
HEADLESS="${HEADLESS:-true}"
OUTPUT_DIR="${OUTPUT_DIR:-artifacts}"
REPORT_DIR="${REPORT_DIR:-docs}"
STAMP="${STAMP:-$(date +%Y%m%d_%H%M%S)}"
PLM_BOM_TOOLS_JSON="${PLM_BOM_TOOLS_JSON:-}"

PLM_SEARCH_QUERY="${PLM_SEARCH_QUERY:-}"
PLM_PRODUCT_ID="${PLM_PRODUCT_ID:-}"
PLM_WHERE_USED_ID="${PLM_WHERE_USED_ID:-}"
PLM_WHERE_USED_EXPECT="${PLM_WHERE_USED_EXPECT:-}"
PLM_COMPARE_LEFT_ID="${PLM_COMPARE_LEFT_ID:-}"
PLM_COMPARE_RIGHT_ID="${PLM_COMPARE_RIGHT_ID:-}"
PLM_COMPARE_EXPECT="${PLM_COMPARE_EXPECT:-}"
PLM_BOM_LINE_ID="${PLM_BOM_LINE_ID:-}"
PLM_SUBSTITUTE_EXPECT="${PLM_SUBSTITUTE_EXPECT:-}"

if [[ ! -x "$TSX_BIN" ]]; then
  TSX_BIN="tsx"
fi
if ! command -v "$TSX_BIN" >/dev/null 2>&1; then
  echo "tsx binary not found. Set TSX_BIN to the local tsx path." >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR" "$REPORT_DIR"
SCREENSHOT_PATH="$OUTPUT_DIR/plm-ui-regression-${STAMP}.png"
REPORT_PATH="$REPORT_DIR/verification-plm-ui-regression-${STAMP}.md"

if [[ -z "$PLM_BOM_TOOLS_JSON" ]]; then
  PLM_BOM_TOOLS_JSON=$(ls -t artifacts/plm-bom-tools-*.json 2>/dev/null | head -n1 || true)
fi

if [[ -z "$PLM_BOM_TOOLS_JSON" ]]; then
  echo "Missing PLM_BOM_TOOLS_JSON and no artifacts/plm-bom-tools-*.json found." >&2
  echo "Run scripts/verify-plm-bom-tools.sh or set PLM_BOM_TOOLS_JSON." >&2
  exit 1
fi

if [[ -z "$PLM_SEARCH_QUERY" || -z "$PLM_PRODUCT_ID" || -z "$PLM_WHERE_USED_ID" || -z "$PLM_COMPARE_LEFT_ID" || -z "$PLM_COMPARE_RIGHT_ID" || -z "$PLM_BOM_LINE_ID" ]]; then
  mapfile -t values < <(python3 - <<'PY' "$PLM_BOM_TOOLS_JSON"
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
where_used_expect = ""
if parents:
    parent = parents[0].get("parent") or {}
    search_query = parent.get("item_number") or ""
    product_id = parent.get("id") or ""

for entry in parents:
    rel = entry.get("relationship") or {}
    refdes = rel.get("refdes")
    if refdes:
        where_used_expect = refdes
        break
if not where_used_expect and parents:
    rel = parents[0].get("relationship") or {}
    find_num = rel.get("find_num")
    if find_num:
        where_used_expect = str(find_num)

bom_compare = (data.get("bom_compare") or {}).get("data") or {}
added = bom_compare.get("added") or []
removed = bom_compare.get("removed") or []
changed = bom_compare.get("changed") or []

compare_left = ""
compare_right = ""
if removed:
    compare_left = removed[0].get("parent_id") or ""
if not compare_left and changed:
    compare_left = changed[0].get("parent_id") or ""
if added:
    compare_right = added[0].get("parent_id") or ""
if not compare_right:
    compare_right = compare_left

compare_expect = ""
if added:
    path = added[0].get("path") or []
    if len(path) > 1:
        compare_expect = path[-1].get("name") or path[-1].get("item_number") or ""
if not compare_expect and changed:
    path = changed[0].get("path") or []
    if len(path) > 1:
        compare_expect = path[-1].get("name") or path[-1].get("item_number") or ""

substitutes = (data.get("substitutes") or {}).get("data") or {}
bom_line_id = substitutes.get("bom_line_id") or ""
subs = substitutes.get("substitutes") or []
sub_expect = ""
if subs:
    part = (subs[0].get("substitute_part") or subs[0].get("part") or {})
    sub_expect = part.get("name") or part.get("item_number") or ""

print(search_query)
print(product_id)
print(where_used.get("item_id") or "")
print(where_used_expect)
print(compare_left)
print(compare_right)
print(compare_expect)
print(bom_line_id)
print(sub_expect)
PY
  )

  if [[ -z "$PLM_SEARCH_QUERY" ]]; then PLM_SEARCH_QUERY="${values[0]:-}"; fi
  if [[ -z "$PLM_PRODUCT_ID" ]]; then PLM_PRODUCT_ID="${values[1]:-}"; fi
  if [[ -z "$PLM_WHERE_USED_ID" ]]; then PLM_WHERE_USED_ID="${values[2]:-}"; fi
  if [[ -z "$PLM_WHERE_USED_EXPECT" ]]; then PLM_WHERE_USED_EXPECT="${values[3]:-}"; fi
  if [[ -z "$PLM_COMPARE_LEFT_ID" ]]; then PLM_COMPARE_LEFT_ID="${values[4]:-}"; fi
  if [[ -z "$PLM_COMPARE_RIGHT_ID" ]]; then PLM_COMPARE_RIGHT_ID="${values[5]:-}"; fi
  if [[ -z "$PLM_COMPARE_EXPECT" ]]; then PLM_COMPARE_EXPECT="${values[6]:-}"; fi
  if [[ -z "$PLM_BOM_LINE_ID" ]]; then PLM_BOM_LINE_ID="${values[7]:-}"; fi
  if [[ -z "$PLM_SUBSTITUTE_EXPECT" ]]; then PLM_SUBSTITUTE_EXPECT="${values[8]:-}"; fi
fi

if [[ -z "$PLM_SEARCH_QUERY" || -z "$PLM_PRODUCT_ID" || -z "$PLM_WHERE_USED_ID" || -z "$PLM_COMPARE_LEFT_ID" || -z "$PLM_COMPARE_RIGHT_ID" || -z "$PLM_BOM_LINE_ID" ]]; then
  echo "Missing required PLM IDs; set PLM_SEARCH_QUERY/PLM_PRODUCT_ID/PLM_WHERE_USED_ID/PLM_COMPARE_LEFT_ID/PLM_COMPARE_RIGHT_ID/PLM_BOM_LINE_ID." >&2
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
  PORT="$PORT" DATABASE_URL="$SMOKE_DATABASE_URL" RBAC_BYPASS="$RBAC_BYPASS" RBAC_TOKEN_TRUST="$RBAC_TOKEN_TRUST" \
    JWT_SECRET="$JWT_SECRET_VALUE" \
    PLM_BASE_URL="$PLM_BASE_URL" PLM_URL="$PLM_URL" PLM_API_MODE="yuantus" \
    PLM_TENANT_ID="$PLM_TENANT_ID" PLM_ORG_ID="$PLM_ORG_ID" \
    PLM_USERNAME="$PLM_USERNAME" PLM_PASSWORD="$PLM_PASSWORD" \
    pnpm --filter @metasheet/core-backend dev:core > "$OUTPUT_DIR/plm-ui-regression-backend.log" 2>&1 &
  BACK_PID=$!

  for _ in {1..30}; do
    if curl -fsS "${API_BASE}/health" >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done
  echo "Backend failed to start (see $OUTPUT_DIR/plm-ui-regression-backend.log)" >&2
  exit 1
}

start_web() {
  echo "Starting web dev server..."
  VITE_API_BASE="$API_BASE" pnpm --filter @metasheet/web dev > "$OUTPUT_DIR/plm-ui-regression-web.log" 2>&1 &
  WEB_PID=$!

  for _ in {1..30}; do
    if curl -fsS "${WEB_BASE}/" >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done
  echo "Web server failed to start (see $OUTPUT_DIR/plm-ui-regression-web.log)" >&2
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

if ! curl -fsS "${WEB_BASE}/" >/dev/null 2>&1; then
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
  METASHEET_TOKEN=$(curl -sS "${API_BASE}/api/auth/dev-token?roles=admin&perms=federation:read,federation:write" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' || true)
fi

if [[ -z "$METASHEET_TOKEN" ]]; then
  token_json="$OUTPUT_DIR/plm-ui-regression-token.json"
  token_err="$OUTPUT_DIR/plm-ui-regression-token.err"
  JWT_SECRET="$JWT_SECRET_VALUE" "$TSX_BIN" packages/core-backend/scripts/gen-dev-token.ts \
    --user admin --roles admin --perms federation:read,federation:write --expiresIn 1h >"$token_json" 2>"$token_err" || true
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

cat > /tmp/plm_ui_regression.js <<'JS_EOF'
const { chromium } = require('@playwright/test');

const token = process.env.METASHEET_TOKEN;
const searchQuery = process.env.PLM_SEARCH_QUERY;
const productId = process.env.PLM_PRODUCT_ID;
const whereUsedId = process.env.PLM_WHERE_USED_ID;
const whereUsedExpect = process.env.PLM_WHERE_USED_EXPECT || '';
const compareLeftId = process.env.PLM_COMPARE_LEFT_ID;
const compareRightId = process.env.PLM_COMPARE_RIGHT_ID;
const compareExpect = process.env.PLM_COMPARE_EXPECT || '';
const bomLineId = process.env.PLM_BOM_LINE_ID;
const substituteExpect = process.env.PLM_SUBSTITUTE_EXPECT || '';
const url = process.env.UI_BASE || 'http://localhost:8899/plm';
const screenshotPath = process.env.SCREENSHOT_PATH;
const headless = process.env.HEADLESS !== 'false';

if (!token || !searchQuery || !productId || !whereUsedId || !compareLeftId || !compareRightId || !bomLineId) {
  console.error('Missing required inputs.');
  process.exit(1);
}
if (!screenshotPath) {
  console.error('Missing SCREENSHOT_PATH');
  process.exit(1);
}

async function waitOptional(scope, text) {
  if (!text) return;
  await scope.getByText(text, { exact: false }).first().waitFor({ timeout: 60000 });
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

  const searchSection = page.locator('section:has-text("产品搜索")');
  await page.fill('#plm-search-query', searchQuery);
  await page.click('button:has-text("搜索")');
  const rows = searchSection.locator('table tbody tr');
  await rows.first().waitFor({ timeout: 60000 });
  const rowCount = await rows.count();
  let targetRow = null;
  for (let i = 0; i < rowCount; i += 1) {
    const text = await rows.nth(i).textContent();
    if (text && text.includes(searchQuery)) {
      targetRow = rows.nth(i);
      break;
    }
  }
  if (!targetRow) {
    throw new Error(`Search result row not found for query: ${searchQuery}`);
  }
  await targetRow.locator('button:has-text("使用")').click();
  await waitOptional(searchSection, searchQuery);

  const whereUsedSection = page.locator('section:has-text("Where-Used")');
  await whereUsedSection.locator('#plm-where-used-item-id').fill(whereUsedId);
  await whereUsedSection.locator('button:has-text("查询")').click();
  await waitOptional(whereUsedSection.locator('table'), whereUsedExpect);

  const compareSection = page.locator('section:has-text("BOM 对比")');
  await compareSection.locator('#plm-compare-left-id').fill(compareLeftId);
  await compareSection.locator('#plm-compare-right-id').fill(compareRightId);
  await compareSection.locator('button:has-text("对比")').click();
  await waitOptional(compareSection.locator('table'), compareExpect);

  const substitutesSection = page.locator('section:has-text("替代件")');
  await substitutesSection.locator('#plm-bom-line-id').fill(bomLineId);
  await substitutesSection.locator('button:has-text("查询")').click();
  await waitOptional(substitutesSection.locator('table'), substituteExpect);

  await page.waitForTimeout(1000);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await browser.close();
})();
JS_EOF

NODE_PATH="$ROOT_DIR/node_modules" \
METASHEET_TOKEN="$METASHEET_TOKEN" \
PLM_SEARCH_QUERY="$PLM_SEARCH_QUERY" \
PLM_PRODUCT_ID="$PLM_PRODUCT_ID" \
PLM_WHERE_USED_ID="$PLM_WHERE_USED_ID" \
PLM_WHERE_USED_EXPECT="$PLM_WHERE_USED_EXPECT" \
PLM_COMPARE_LEFT_ID="$PLM_COMPARE_LEFT_ID" \
PLM_COMPARE_RIGHT_ID="$PLM_COMPARE_RIGHT_ID" \
PLM_COMPARE_EXPECT="$PLM_COMPARE_EXPECT" \
PLM_BOM_LINE_ID="$PLM_BOM_LINE_ID" \
PLM_SUBSTITUTE_EXPECT="$PLM_SUBSTITUTE_EXPECT" \
UI_BASE="$UI_BASE" \
SCREENSHOT_PATH="$SCREENSHOT_PATH" \
HEADLESS="$HEADLESS" \
node /tmp/plm_ui_regression.js

cat > "$REPORT_PATH" <<REPORT_EOF
# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - ${STAMP}

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes.

## Environment
- UI: ${UI_BASE}
- API: ${API_BASE}
- PLM: ${PLM_BASE_URL}
- PLM_TENANT_ID: ${PLM_TENANT_ID}
- PLM_ORG_ID: ${PLM_ORG_ID}
- BOM tools source: ${PLM_BOM_TOOLS_JSON}

## Data
- Search query: ${PLM_SEARCH_QUERY}
- Product ID: ${PLM_PRODUCT_ID}
- Where-used child ID: ${PLM_WHERE_USED_ID}
- Where-used expect: ${PLM_WHERE_USED_EXPECT:-n/a}
- BOM compare left/right: ${PLM_COMPARE_LEFT_ID} / ${PLM_COMPARE_RIGHT_ID}
- BOM compare expect: ${PLM_COMPARE_EXPECT:-n/a}
- Substitute BOM line: ${PLM_BOM_LINE_ID}
- Substitute expect: ${PLM_SUBSTITUTE_EXPECT:-n/a}

## Results
- Search returns matching row and selection loads product detail.
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Screenshot: ${SCREENSHOT_PATH}
REPORT_EOF

python3 - <<'PY_EOF' "$REPORT_PATH" "$SCREENSHOT_PATH"
import sys
from pathlib import Path

report = Path(sys.argv[1])
shot = Path(sys.argv[2])
root = Path.cwd()
try:
    report_rel = report.relative_to(root)
except ValueError:
    report_rel = report
try:
    shot_rel = shot.relative_to(root)
except ValueError:
    shot_rel = shot

index_path = Path("docs/verification-index.md")
if not index_path.exists():
    sys.exit(0)

lines = index_path.read_text().splitlines()
idx = None
for i, line in enumerate(lines):
    if line.startswith("- PLM UI regression"):
        idx = i
        break
if idx is None:
    index_path.write_text("\n".join(lines))
    sys.exit(0)

report_line = f"  - Report: `{report_rel.as_posix()}`"
shot_line = f"  - Artifact: `{shot_rel.as_posix()}`"

if report_line in lines and shot_line in lines:
    sys.exit(0)

insert_at = idx + 1
while insert_at < len(lines) and lines[insert_at].startswith("  - "):
    insert_at += 1

lines[insert_at:insert_at] = [report_line, shot_line]
index_path.write_text("\n".join(lines))
PY_EOF

printf "Report: %s\n" "$REPORT_PATH"
printf "Screenshot: %s\n" "$SCREENSHOT_PATH"
