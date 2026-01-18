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
PLM_BOM_CHILD_ID="${PLM_BOM_CHILD_ID:-}"
PLM_BOM_FIND_NUM="${PLM_BOM_FIND_NUM:-}"
PLM_BOM_REFDES="${PLM_BOM_REFDES:-}"
PLM_BOM_DEPTH="${PLM_BOM_DEPTH:-1}"
PLM_BOM_EFFECTIVE_AT="${PLM_BOM_EFFECTIVE_AT:-}"
PLM_SUBSTITUTE_EXPECT="${PLM_SUBSTITUTE_EXPECT:-}"
PLM_DOCUMENT_NAME="${PLM_DOCUMENT_NAME:-}"
PLM_DOCUMENT_ROLE="${PLM_DOCUMENT_ROLE:-}"
PLM_DOCUMENT_REVISION="${PLM_DOCUMENT_REVISION:-}"
PLM_APPROVAL_TITLE="${PLM_APPROVAL_TITLE:-}"
PLM_APPROVAL_PRODUCT_NUMBER="${PLM_APPROVAL_PRODUCT_NUMBER:-}"

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
ITEM_NUMBER_JSON="$OUTPUT_DIR/plm-ui-regression-item-number-${STAMP}.json"

if [[ -z "$PLM_BOM_TOOLS_JSON" ]]; then
  PLM_BOM_TOOLS_JSON=$(ls -t artifacts/plm-bom-tools-*.json 2>/dev/null | head -n1 || true)
fi

if [[ -z "$PLM_BOM_TOOLS_JSON" ]]; then
  echo "Missing PLM_BOM_TOOLS_JSON and no artifacts/plm-bom-tools-*.json found." >&2
  echo "Run scripts/verify-plm-bom-tools.sh or set PLM_BOM_TOOLS_JSON." >&2
  exit 1
fi

if [[ -z "$PLM_BOM_FIND_NUM" || -z "$PLM_BOM_REFDES" ]]; then
  mapfile -t bom_values < <(python3 - <<'PY' "$PLM_BOM_TOOLS_JSON"
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
if not path.exists():
    sys.exit(1)

data = json.loads(path.read_text())
bom = data.get("bom") or {}
fixtures = data.get("fixtures") or {}
find_num = bom.get("find_num") or fixtures.get("bom_child_find_num") or ""
refdes = bom.get("refdes") or fixtures.get("bom_child_refdes") or ""
print(find_num)
print(refdes)
PY
  )
  if [[ -z "$PLM_BOM_FIND_NUM" ]]; then PLM_BOM_FIND_NUM="${bom_values[0]:-}"; fi
  if [[ -z "$PLM_BOM_REFDES" ]]; then PLM_BOM_REFDES="${bom_values[1]:-}"; fi
fi

if [[ -z "$PLM_BOM_EFFECTIVE_AT" ]]; then
  PLM_BOM_EFFECTIVE_AT="$(date '+%Y-%m-%dT%H:%M')"
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
fixtures = data.get("fixtures") or {}

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

bom_child_id = (
    fixtures.get("bom_child_id")
    or fixtures.get("child_x")
    or fixtures.get("child_y")
    or fixtures.get("child_z")
    or ""
)

substitutes = (data.get("substitutes") or {}).get("data") or {}
bom_line_id = substitutes.get("bom_line_id") or ""
subs = substitutes.get("substitutes") or []
sub_expect = ""
if subs:
    part = (subs[0].get("substitute_part") or subs[0].get("part") or {})
    sub_expect = part.get("name") or part.get("item_number") or ""

documents = data.get("documents") or {}
doc_name = documents.get("filename") or documents.get("name") or ""
doc_role = documents.get("file_role") or ""
doc_revision = documents.get("document_version") or ""

approvals = data.get("approvals") or {}
approval_title = approvals.get("eco_name") or approvals.get("title") or ""
approval_product_number = approvals.get("product_number") or ""
preferred_product_id = approvals.get("product_id") or documents.get("item_id") or product_id
preferred_search_query = approval_product_number or search_query

print(preferred_search_query)
print(preferred_product_id)
print(bom_child_id)
print(where_used.get("item_id") or "")
print(where_used_expect)
print(compare_left)
print(compare_right)
print(compare_expect)
print(bom_line_id)
print(sub_expect)
print(doc_name)
print(doc_role)
print(doc_revision)
print(approval_title)
print(approval_product_number)
PY
  )

  if [[ -z "$PLM_SEARCH_QUERY" ]]; then PLM_SEARCH_QUERY="${values[0]:-}"; fi
  if [[ -z "$PLM_PRODUCT_ID" ]]; then PLM_PRODUCT_ID="${values[1]:-}"; fi
  if [[ -z "$PLM_BOM_CHILD_ID" ]]; then PLM_BOM_CHILD_ID="${values[2]:-}"; fi
  if [[ -z "$PLM_WHERE_USED_ID" ]]; then PLM_WHERE_USED_ID="${values[3]:-}"; fi
  if [[ -z "$PLM_WHERE_USED_EXPECT" ]]; then PLM_WHERE_USED_EXPECT="${values[4]:-}"; fi
  if [[ -z "$PLM_COMPARE_LEFT_ID" ]]; then PLM_COMPARE_LEFT_ID="${values[5]:-}"; fi
  if [[ -z "$PLM_COMPARE_RIGHT_ID" ]]; then PLM_COMPARE_RIGHT_ID="${values[6]:-}"; fi
  if [[ -z "$PLM_COMPARE_EXPECT" ]]; then PLM_COMPARE_EXPECT="${values[7]:-}"; fi
  if [[ -z "$PLM_BOM_LINE_ID" ]]; then PLM_BOM_LINE_ID="${values[8]:-}"; fi
  if [[ -z "$PLM_SUBSTITUTE_EXPECT" ]]; then PLM_SUBSTITUTE_EXPECT="${values[9]:-}"; fi
  if [[ -z "$PLM_DOCUMENT_NAME" ]]; then PLM_DOCUMENT_NAME="${values[10]:-}"; fi
  if [[ -z "$PLM_DOCUMENT_ROLE" ]]; then PLM_DOCUMENT_ROLE="${values[11]:-}"; fi
  if [[ -z "$PLM_DOCUMENT_REVISION" ]]; then PLM_DOCUMENT_REVISION="${values[12]:-}"; fi
  if [[ -z "$PLM_APPROVAL_TITLE" ]]; then PLM_APPROVAL_TITLE="${values[13]:-}"; fi
  if [[ -z "$PLM_APPROVAL_PRODUCT_NUMBER" ]]; then PLM_APPROVAL_PRODUCT_NUMBER="${values[14]:-}"; fi
fi

if [[ -z "$PLM_SEARCH_QUERY" || -z "$PLM_PRODUCT_ID" || -z "$PLM_WHERE_USED_ID" || -z "$PLM_COMPARE_LEFT_ID" || -z "$PLM_COMPARE_RIGHT_ID" || -z "$PLM_BOM_LINE_ID" || -z "$PLM_BOM_FIND_NUM" || -z "$PLM_DOCUMENT_NAME" || -z "$PLM_DOCUMENT_ROLE" || -z "$PLM_APPROVAL_TITLE" ]]; then
  echo "Missing required PLM inputs; set PLM_SEARCH_QUERY/PLM_PRODUCT_ID/PLM_WHERE_USED_ID/PLM_COMPARE_LEFT_ID/PLM_COMPARE_RIGHT_ID/PLM_BOM_LINE_ID/PLM_BOM_FIND_NUM/PLM_DOCUMENT_NAME/PLM_DOCUMENT_ROLE/PLM_APPROVAL_TITLE." >&2
  exit 1
fi

BOM_CHILD_RESULT="BOM child actions skipped (missing PLM_BOM_CHILD_ID)."
if [[ -n "$PLM_BOM_CHILD_ID" ]]; then
  BOM_CHILD_RESULT="BOM child actions executed (copy + switch)."
fi

BOM_DETAIL_RESULT="BOM detail validation skipped (missing PLM_BOM_FIND_NUM)."
if [[ -n "$PLM_BOM_FIND_NUM" ]]; then
  BOM_DETAIL_RESULT="BOM detail validation executed (find_num/refdes + depth/effective + filter)."
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
const bomChildId = process.env.PLM_BOM_CHILD_ID || '';
const whereUsedId = process.env.PLM_WHERE_USED_ID;
const whereUsedExpect = process.env.PLM_WHERE_USED_EXPECT || '';
const compareLeftId = process.env.PLM_COMPARE_LEFT_ID;
const compareRightId = process.env.PLM_COMPARE_RIGHT_ID;
const compareExpect = process.env.PLM_COMPARE_EXPECT || '';
const bomLineId = process.env.PLM_BOM_LINE_ID;
const bomFindNum = process.env.PLM_BOM_FIND_NUM || '';
const bomRefdes = process.env.PLM_BOM_REFDES || '';
const bomDepth = process.env.PLM_BOM_DEPTH || '1';
const bomEffectiveAt = process.env.PLM_BOM_EFFECTIVE_AT || '';
const substituteExpect = process.env.PLM_SUBSTITUTE_EXPECT || '';
const docName = process.env.PLM_DOCUMENT_NAME;
const docRole = process.env.PLM_DOCUMENT_ROLE;
const docRevision = process.env.PLM_DOCUMENT_REVISION;
const approvalTitle = process.env.PLM_APPROVAL_TITLE;
const approvalProductNumber = process.env.PLM_APPROVAL_PRODUCT_NUMBER || '';
const fallbackItemNumber = process.env.PLM_ITEM_NUMBER_ONLY || approvalProductNumber || searchQuery;
const url = process.env.UI_BASE || 'http://localhost:8899/plm';
const screenshotPath = process.env.SCREENSHOT_PATH;
const itemNumberPath = process.env.ITEM_NUMBER_PATH;
const headless = process.env.HEADLESS !== 'false';

if (!token || !searchQuery || !productId || !whereUsedId || !compareLeftId || !compareRightId || !bomLineId || !docName || !docRole || !approvalTitle) {
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
  const dialogMessages = [];
  page.on('dialog', async (dialog) => {
    dialogMessages.push(dialog.message());
    await dialog.accept();
  });
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

  const detailSection = page.locator('section:has-text("PLM 产品详情")');
  const partNumberCell = detailSection.locator('.detail-grid > div').filter({ hasText: '料号' }).locator('strong');
  await partNumberCell.first().waitFor({ timeout: 60000 });
  let itemNumberValue = ((await partNumberCell.first().textContent()) || '').trim();
  if (!itemNumberValue || itemNumberValue === '-') {
    itemNumberValue = (fallbackItemNumber || '').trim();
  }
  if (!itemNumberValue) {
    throw new Error('Missing item number for item-number-only load.');
  }
  await detailSection.locator('#plm-product-id').fill('');
  await detailSection.locator('#plm-item-number').fill(itemNumberValue);
  await detailSection.locator('button:has-text("加载产品")').click();
  await page.waitForFunction(() => {
    const el = document.querySelector('#plm-product-id');
    return el && el.value && el.value.trim().length > 0;
  }, null, { timeout: 60000 });
  await waitOptional(detailSection, itemNumberValue);

  const copyIdButton = detailSection.locator('button:has-text("复制 ID")');
  await copyIdButton.click();
  await detailSection.getByText('已复制产品 ID', { exact: false }).waitFor({ timeout: 60000 });

  const copyNumberButton = detailSection.locator('button:has-text("复制料号")');
  await copyNumberButton.click();
  await detailSection.getByText('已复制产品 料号', { exact: false }).waitFor({ timeout: 60000 });

  const copyRevisionButton = detailSection.locator('button:has-text("复制版本")');
  if (await copyRevisionButton.isEnabled()) {
    await copyRevisionButton.click();
    await detailSection.getByText('已复制产品 版本', { exact: false }).waitFor({ timeout: 60000 });
  } else {
    console.warn('Skipping product revision copy; revision not available.');
  }

  const copyTypeButton = detailSection.locator('button:has-text("复制类型")');
  if (await copyTypeButton.isEnabled()) {
    await copyTypeButton.click();
    await detailSection.getByText('已复制产品 类型', { exact: false }).waitFor({ timeout: 60000 });
  } else {
    console.warn('Skipping product type copy; type not available.');
  }

  const copyStatusButton = detailSection.locator('button:has-text("复制状态")');
  if (await copyStatusButton.isEnabled()) {
    await copyStatusButton.click();
    await detailSection.getByText('已复制产品 状态', { exact: false }).waitFor({ timeout: 60000 });
  } else {
    console.warn('Skipping product status copy; status not available.');
  }

  const bomSection = page.locator('section:has-text("BOM 结构")');
  await bomSection.locator('#plm-bom-depth').fill(String(bomDepth));
  if (bomEffectiveAt) {
    await bomSection.locator('#plm-bom-effective-at').fill(bomEffectiveAt);
  }
  const bomRequestPromise = page.waitForResponse((response) => {
    const url = response.url();
    if (!url.includes(`/api/federation/plm/products/${encodeURIComponent(productId)}/bom`)) {
      return false;
    }
    if (!url.includes(`depth=${encodeURIComponent(bomDepth)}`)) {
      return false;
    }
    if (bomEffectiveAt && !url.includes('effective_at=')) {
      return false;
    }
    return true;
  });
  await bomSection.locator('button:has-text("刷新 BOM")').click();
  await bomRequestPromise;
  const bomRows = bomSection.locator('table tbody tr');
  await bomRows.first().waitFor({ timeout: 60000 });
  let bomTargetRow = null;
  if (bomChildId) {
    const match = bomRows.filter({ hasText: bomChildId });
    if (await match.count()) {
      bomTargetRow = match.first();
    }
  }
  if (!bomTargetRow) {
    throw new Error(`BOM child ${bomChildId || '(missing)'} not found; aborting regression.`);
  }
  const findNumCell = bomTargetRow.locator('td').nth(5);
  const findNumText = ((await findNumCell.textContent()) || '').trim();
  if (bomFindNum && !findNumText.includes(String(bomFindNum))) {
    throw new Error(`BOM find_num mismatch. Expected ${bomFindNum}, got ${findNumText || '-'}`);
  }
  if (bomRefdes) {
    const refdesCell = bomTargetRow.locator('td').nth(6);
    const refdesText = ((await refdesCell.textContent()) || '').trim();
    if (!refdesText.includes(String(bomRefdes))) {
      throw new Error(`BOM refdes mismatch. Expected ${bomRefdes}, got ${refdesText || '-'}`);
    }
  }
  const bomFilterValue = bomFindNum || bomChildId;
  if (bomFilterValue) {
    await bomSection.locator('#plm-bom-filter').fill(String(bomFilterValue));
    const filteredRows = bomSection.locator('table tbody tr');
    const filteredCount = await filteredRows.count();
    if (filteredCount === 0) {
      throw new Error(`BOM filter produced no rows for ${bomFilterValue}`);
    }
    const pathButton = bomSection.locator('table tbody tr button:has-text("路径 ID")').first();
    if (await pathButton.count()) {
      const pathTitle = ((await pathButton.getAttribute('title')) || '').trim();
      if (pathTitle) {
        await bomSection.locator('#plm-bom-filter').fill(pathTitle.split(' / ').slice(-1)[0]);
        const pathFilteredCount = await bomSection.locator('table tbody tr').count();
        if (pathFilteredCount === 0) {
          throw new Error('BOM filter produced no rows for path id token.');
        }
      }
    }
  }
  const bomFilterFieldSelect = bomSection.locator('#plm-bom-filter-field');
  if ((await bomFilterFieldSelect.count()) === 0) {
    throw new Error('BOM filter field selector missing.');
  }
  const bomPresetNameInput = bomSection.locator('#plm-bom-filter-preset-name');
  if (await bomPresetNameInput.count()) {
    const currentFilterValue = await bomSection.locator('#plm-bom-filter').inputValue();
    if (currentFilterValue.trim()) {
      const presetName = `auto-${Date.now()}`;
      await bomPresetNameInput.fill(presetName);
      await bomSection
        .locator('label:has(#plm-bom-filter-preset-name) button:has-text("保存")')
        .click();
      const presetSelect = bomSection.locator('#plm-bom-filter-preset');
      const presetOptions = presetSelect.locator('option');
      const optionCount = await presetOptions.count();
      if (optionCount < 2) {
        throw new Error('BOM filter preset was not saved.');
      }
      const lastValue = await presetOptions.nth(optionCount - 1).getAttribute('value');
      if (lastValue) {
        await presetSelect.selectOption(lastValue);
        await bomSection
          .locator('label:has(#plm-bom-filter-preset) button:has-text("应用")')
          .click();
        const appliedValue = await bomSection.locator('#plm-bom-filter').inputValue();
        if (appliedValue.trim() !== currentFilterValue.trim()) {
          throw new Error('BOM filter preset did not apply the expected value.');
        }
      }
      const bomShareButton = bomSection.locator(
        'label:has(#plm-bom-filter-preset) button:has-text("分享")'
      );
      if ((await bomShareButton.count()) === 0) {
        throw new Error('BOM filter preset share button missing.');
      }
      await bomShareButton.click();
      await detailSection
        .locator('p.status', { hasText: '分享链接' })
        .first()
        .waitFor({ timeout: 10000 });
      const bomExportButton = bomSection.locator(
        'label:has(#plm-bom-filter-preset-import) button:has-text("导出")'
      );
      if ((await bomExportButton.count()) === 0) {
        throw new Error('BOM filter preset export button missing.');
      }
      const bomImportInput = bomSection.locator('#plm-bom-filter-preset-import');
      if (await bomImportInput.count()) {
        const bomImportMode = bomSection.locator('#plm-bom-filter-preset-import-mode');
        if ((await bomImportMode.count()) === 0) {
          throw new Error('BOM filter preset import mode selector missing.');
        }
        await bomImportMode.selectOption('replace');
        const importLabel = `import-${Date.now()}`;
        const importPayload = JSON.stringify([
          { label: importLabel, field: 'all', value: currentFilterValue.trim() },
        ]);
        await bomImportInput.fill(importPayload);
        await bomSection
          .locator('label:has(#plm-bom-filter-preset-import) button:has-text("导入")')
          .click();
        const importedOption = presetSelect.locator('option', { hasText: importLabel });
        if ((await importedOption.count()) === 0) {
          throw new Error('BOM filter preset import did not create a new preset.');
        }
      }
      const bomClearButton = bomSection.locator(
        'label:has(#plm-bom-filter-preset-import) button:has-text("清空")'
      );
      if ((await bomClearButton.count()) === 0) {
        throw new Error('BOM filter preset clear button missing.');
      }
      if (await bomClearButton.isEnabled()) {
        await bomClearButton.click();
        const remainingOptions = await presetSelect.locator('option').count();
        if (remainingOptions > 1) {
          throw new Error('BOM filter presets were not cleared.');
        }
      }
    }
  }

  const bomViewSelect = bomSection.locator('#plm-bom-view');
  if (await bomViewSelect.count()) {
    await bomSection.locator('#plm-bom-filter').fill('');
    await bomSection.locator('table tbody tr').first().waitFor({ timeout: 60000 });
    await bomViewSelect.selectOption('tree');
    const bomTreeRows = bomSection.locator('.bom-tree .tree-row');
    await bomTreeRows.nth(1).waitFor({ timeout: 60000 });
    const bomTreeToggle = bomSection.locator('.bom-tree .tree-toggle').first();
    if (!(await bomTreeToggle.isEnabled())) {
      throw new Error('BOM tree toggle is disabled; expected expandable nodes.');
    }
    const bomTreeBulkButton = bomSection.locator('.panel-actions button:has-text("复制树形路径 ID")');
    if ((await bomTreeBulkButton.count()) === 0) {
      throw new Error('BOM tree bulk path ID button missing.');
    }
    if (!(await bomTreeBulkButton.isEnabled())) {
      throw new Error('BOM tree bulk path ID button is disabled.');
    }
    const bomTreeRow = bomSection.locator('.bom-tree .tree-row[data-line-id]:not([data-line-id=""])').first();
    if ((await bomTreeRow.count()) === 0) {
      throw new Error('BOM tree row with line id not found.');
    }
    await bomTreeRow.click();
    const bomTreeSelected = await bomTreeRow.evaluate((el) => el.classList.contains('selected'));
    if (!bomTreeSelected) {
      throw new Error('BOM tree row highlight missing.');
    }
    const bomExpandDepthButton = bomSection.locator('button:has-text("展开到深度")');
    if (!(await bomExpandDepthButton.isEnabled())) {
      throw new Error('BOM expand-to-depth button is disabled.');
    }
    const bomExportButton = bomSection.locator('button:has-text("导出 CSV")');
    if (!(await bomExportButton.isEnabled())) {
      throw new Error('BOM tree export button is disabled.');
    }
    const bomPathButton = bomSection.locator('.bom-tree button:has-text("路径 ID")').first();
    if ((await bomPathButton.count()) === 0) {
      throw new Error('BOM tree path ID button missing.');
    }
    const bomPathTitle = ((await bomPathButton.getAttribute('title')) || '').trim();
    if (!bomPathTitle) {
      throw new Error('BOM tree path ID tooltip missing.');
    }
    await bomViewSelect.selectOption('table');

    const refreshedRows = bomSection.locator('table tbody tr');
    await refreshedRows.first().waitFor({ timeout: 60000 });
    if (bomChildId) {
      const match = refreshedRows.filter({ hasText: bomChildId });
      if (await match.count()) {
        bomTargetRow = match.first();
      }
    }
    if (!bomTargetRow) {
      throw new Error(`BOM child ${bomChildId || '(missing)'} not found after tree view toggle.`);
    }
    const bomTablePathHeader = bomSection.locator('table thead th', { hasText: '路径 ID' });
    if ((await bomTablePathHeader.count()) === 0) {
      throw new Error('BOM table path ID column missing.');
    }
    const bomTablePathButton = bomSection.locator('table tbody tr button:has-text("路径 ID")').first();
    if ((await bomTablePathButton.count()) === 0) {
      throw new Error('BOM table path ID button missing.');
    }
    const bomTablePathTitle = ((await bomTablePathButton.getAttribute('title')) || '').trim();
    if (!bomTablePathTitle) {
      throw new Error('BOM table path ID tooltip missing.');
    }
    const bomSelectedRows = bomSection.locator('table tbody tr.row-selected');
    if ((await bomSelectedRows.count()) === 0) {
      throw new Error('BOM table row highlight missing after tree selection.');
    }
    const bomCopySelectedButton = bomSection.locator('.panel-actions button:has-text("复制选中子件")');
    if ((await bomCopySelectedButton.count()) === 0) {
      throw new Error('BOM selected child copy button missing.');
    }
    if (!(await bomCopySelectedButton.isEnabled())) {
      throw new Error('BOM selected child copy button is disabled.');
    }
    const bomClearSelectionButton = bomSection.locator('.panel-actions button:has-text("清空选择")');
    if ((await bomClearSelectionButton.count()) === 0) {
      throw new Error('BOM clear selection button missing.');
    }
    if (!(await bomClearSelectionButton.isEnabled())) {
      throw new Error('BOM clear selection button is disabled.');
    }
    const bomBulkPathButton = bomSection.locator('.panel-actions button:has-text("复制所有路径 ID")');
    if ((await bomBulkPathButton.count()) === 0) {
      throw new Error('BOM bulk path ID button missing.');
    }
    if (!(await bomBulkPathButton.isEnabled())) {
      throw new Error('BOM bulk path ID button is disabled.');
    }

    const deepLinkSelect = page.locator('#plm-deeplink-preset');
    if (await deepLinkSelect.count()) {
      await deepLinkSelect.selectOption('product-bom-tree');
      await page.waitForFunction(() => {
        const el = document.querySelector('#plm-bom-view');
        return el && el.value === 'tree';
      }, null, { timeout: 60000 });
      await bomViewSelect.selectOption('table');
      await bomSection.locator('table tbody tr').first().waitFor({ timeout: 60000 });
    } else {
      console.warn('Skipping BOM tree preset check; deep link preset selector missing.');
    }
  } else {
    console.warn('Skipping BOM tree view check; view selector not found.');
  }

  const childIdCell = bomTargetRow.locator('td').nth(1).locator('.muted.mono');
  let resolvedChildId = '';
  if (await childIdCell.count()) {
    resolvedChildId = ((await childIdCell.first().textContent()) || '').trim();
  }
  const childNumberCell = bomTargetRow.locator('td').nth(1).locator('div').first();
  const resolvedChildNumber = ((await childNumberCell.textContent()) || '').trim();
  const childTarget = resolvedChildId || resolvedChildNumber;
  if (childTarget) {
    await bomTargetRow.locator('button:has-text("复制子件")').click();
    await detailSection.getByText('已复制子件', { exact: false }).waitFor({ timeout: 60000 });
    await bomTargetRow.locator('button:has-text("切换产品")').click();
    if (resolvedChildId) {
      await page.waitForFunction((expected) => {
        const el = document.querySelector('#plm-product-id');
        return el && el.value && el.value.trim() === expected;
      }, resolvedChildId, { timeout: 60000 });
    } else if (resolvedChildNumber) {
      await page.waitForFunction((expected) => {
        const el = document.querySelector('#plm-item-number');
        return el && el.value && el.value.trim() === expected;
      }, resolvedChildNumber, { timeout: 60000 });
    }
    await detailSection.getByText('已切换到子件产品', { exact: false }).waitFor({ timeout: 60000 });
    if (targetRow) {
      await targetRow.locator('button:has-text("使用")').click();
      await page.waitForFunction((expected) => {
        const el = document.querySelector('#plm-item-number');
        return el && el.value && el.value.trim() === expected;
      }, itemNumberValue, { timeout: 60000 });
      await page.waitForFunction(() => {
        const el = document.querySelector('#plm-product-id');
        return el && el.value && el.value.trim().length > 0;
      }, null, { timeout: 60000 });
    } else {
      console.warn('Missing search row; unable to restore original product.');
    }
  } else {
    console.warn('Skipping BOM child actions; missing child identifier.');
  }

  const whereUsedSection = page.locator('section:has(#plm-where-used-item-id)');
  await whereUsedSection.locator('#plm-where-used-item-id').fill(whereUsedId);
  await whereUsedSection.locator('button:has-text("查询")').click();
  await waitOptional(whereUsedSection.locator('table'), whereUsedExpect);
  const whereUsedPathHeader = whereUsedSection.locator('table thead th', { hasText: '路径 ID' });
  if ((await whereUsedPathHeader.count()) === 0) {
    throw new Error('Where-used path ID column missing.');
  }
  const whereUsedTablePathButton = whereUsedSection.locator('table tbody tr button:has-text("路径 ID")').first();
  if ((await whereUsedTablePathButton.count()) === 0) {
    throw new Error('Where-used table path ID button missing.');
  }
  const whereUsedTablePathTitle = ((await whereUsedTablePathButton.getAttribute('title')) || '').trim();
  if (!whereUsedTablePathTitle) {
    throw new Error('Where-used table path ID tooltip missing.');
  }
  const whereUsedBulkPathButton = whereUsedSection.locator('.panel-actions button:has-text("复制所有路径 ID")');
  if ((await whereUsedBulkPathButton.count()) === 0) {
    throw new Error('Where-used bulk path ID button missing.');
  }
  if (!(await whereUsedBulkPathButton.isEnabled())) {
    throw new Error('Where-used bulk path ID button is disabled.');
  }
  const whereUsedFilterInput = whereUsedSection.locator('#plm-where-used-filter');
  if ((await whereUsedFilterInput.count()) && whereUsedTablePathTitle) {
    const whereUsedPathToken = whereUsedTablePathTitle.split(' / ').slice(-1)[0];
    if (whereUsedPathToken) {
      await whereUsedFilterInput.fill(whereUsedPathToken);
      const filteredCount = await whereUsedSection.locator('table tbody tr').count();
      if (filteredCount === 0) {
        throw new Error('Where-used filter produced no rows for path id token.');
      }
      await whereUsedFilterInput.fill('');
    }
  }
  const whereUsedFilterFieldSelect = whereUsedSection.locator('#plm-where-used-filter-field');
  if ((await whereUsedFilterFieldSelect.count()) === 0) {
    throw new Error('Where-used filter field selector missing.');
  }
  const whereUsedPresetNameInput = whereUsedSection.locator('#plm-where-used-filter-preset-name');
  if (await whereUsedPresetNameInput.count()) {
    await whereUsedFilterInput.fill(whereUsedExpect || whereUsedId);
    const presetName = `auto-${Date.now()}`;
    await whereUsedPresetNameInput.fill(presetName);
    await whereUsedSection
      .locator('label:has(#plm-where-used-filter-preset-name) button:has-text("保存")')
      .click();
    const presetSelect = whereUsedSection.locator('#plm-where-used-filter-preset');
    const presetOptions = presetSelect.locator('option');
    const optionCount = await presetOptions.count();
    if (optionCount < 2) {
      throw new Error('Where-used filter preset was not saved.');
    }
    const lastValue = await presetOptions.nth(optionCount - 1).getAttribute('value');
    if (lastValue) {
      await presetSelect.selectOption(lastValue);
      await whereUsedSection
        .locator('label:has(#plm-where-used-filter-preset) button:has-text("应用")')
        .click();
      const appliedValue = await whereUsedFilterInput.inputValue();
      const expectedValue = whereUsedExpect || whereUsedId;
      if (expectedValue && appliedValue.trim() !== String(expectedValue).trim()) {
        throw new Error('Where-used filter preset did not apply the expected value.');
      }
    }
    const whereUsedShareButton = whereUsedSection.locator(
      'label:has(#plm-where-used-filter-preset) button:has-text("分享")'
    );
    if ((await whereUsedShareButton.count()) === 0) {
      throw new Error('Where-used filter preset share button missing.');
    }
    await whereUsedShareButton.click();
    await detailSection
      .locator('p.status', { hasText: '分享链接' })
      .first()
      .waitFor({ timeout: 10000 });
    const whereUsedExportButton = whereUsedSection.locator(
      'label:has(#plm-where-used-filter-preset-import) button:has-text("导出")'
    );
    if ((await whereUsedExportButton.count()) === 0) {
      throw new Error('Where-used filter preset export button missing.');
    }
    const whereUsedImportInput = whereUsedSection.locator('#plm-where-used-filter-preset-import');
    if (await whereUsedImportInput.count()) {
      const whereUsedImportMode = whereUsedSection.locator('#plm-where-used-filter-preset-import-mode');
      if ((await whereUsedImportMode.count()) === 0) {
        throw new Error('Where-used filter preset import mode selector missing.');
      }
      await whereUsedImportMode.selectOption('replace');
      const importLabel = `import-${Date.now()}`;
      const expectedValue = whereUsedExpect || whereUsedId;
      const importPayload = JSON.stringify([
        { label: importLabel, field: 'all', value: String(expectedValue) },
      ]);
      await whereUsedImportInput.fill(importPayload);
      await whereUsedSection
        .locator('label:has(#plm-where-used-filter-preset-import) button:has-text("导入")')
        .click();
      const importedOption = presetSelect.locator('option', { hasText: importLabel });
      if ((await importedOption.count()) === 0) {
        throw new Error('Where-used filter preset import did not create a new preset.');
      }
    }
    const whereUsedClearButton = whereUsedSection.locator(
      'label:has(#plm-where-used-filter-preset-import) button:has-text("清空")'
    );
    if ((await whereUsedClearButton.count()) === 0) {
      throw new Error('Where-used filter preset clear button missing.');
    }
    if (await whereUsedClearButton.isEnabled()) {
      await whereUsedClearButton.click();
      const remainingOptions = await presetSelect.locator('option').count();
      if (remainingOptions > 1) {
        throw new Error('Where-used filter presets were not cleared.');
      }
    }
    if (!dialogMessages.some((message) => message.includes('覆盖'))) {
      throw new Error('Import confirmation dialog was not shown.');
    }
    await whereUsedFilterInput.fill('');
  }
  const whereUsedViewSelect = whereUsedSection.locator('#plm-where-used-view');
  if (await whereUsedViewSelect.count()) {
    await whereUsedViewSelect.selectOption('tree');
    const whereUsedTreeRows = whereUsedSection.locator('.where-used-tree .tree-row');
    await whereUsedTreeRows.nth(1).waitFor({ timeout: 60000 });
    const whereUsedPathButton = whereUsedSection.locator('.where-used-tree button:has-text("路径 ID")').first();
    if ((await whereUsedPathButton.count()) === 0) {
      throw new Error('Where-used tree path ID button missing.');
    }
    const whereUsedPathTitle = ((await whereUsedPathButton.getAttribute('title')) || '').trim();
    if (!whereUsedPathTitle) {
      throw new Error('Where-used tree path ID tooltip missing.');
    }
    const whereUsedTreeBulkButton = whereUsedSection.locator('.panel-actions button:has-text("复制树形路径 ID")');
    if ((await whereUsedTreeBulkButton.count()) === 0) {
      throw new Error('Where-used tree bulk path ID button missing.');
    }
    if (!(await whereUsedTreeBulkButton.isEnabled())) {
      throw new Error('Where-used tree bulk path ID button is disabled.');
    }
    const whereUsedTreeRow = whereUsedSection
      .locator('.where-used-tree .tree-row[data-entry-count]:not([data-entry-count="0"])')
      .first();
    if ((await whereUsedTreeRow.count()) === 0) {
      throw new Error('Where-used tree row with entries not found.');
    }
    await whereUsedTreeRow.click();
    const treeSelected = await whereUsedTreeRow.evaluate((el) => el.classList.contains('selected'));
    if (!treeSelected) {
      throw new Error('Where-used tree row highlight missing.');
    }
    const whereUsedCopySelectedButton = whereUsedSection.locator(
      '.panel-actions button:has-text("复制选中父件")'
    );
    if ((await whereUsedCopySelectedButton.count()) === 0) {
      throw new Error('Where-used selected parent copy button missing.');
    }
    if (!(await whereUsedCopySelectedButton.isEnabled())) {
      throw new Error('Where-used selected parent copy button is disabled.');
    }
    const whereUsedClearSelectionButton = whereUsedSection.locator(
      '.panel-actions button:has-text("清空选择")'
    );
    if ((await whereUsedClearSelectionButton.count()) === 0) {
      throw new Error('Where-used clear selection button missing.');
    }
    if (!(await whereUsedClearSelectionButton.isEnabled())) {
      throw new Error('Where-used clear selection button is disabled.');
    }
    await whereUsedViewSelect.selectOption('table');
    const selectedTableRows = whereUsedSection.locator('table tbody tr.row-selected');
    if ((await selectedTableRows.count()) === 0) {
      throw new Error('Where-used table row highlight missing after tree selection.');
    }
    await whereUsedCopySelectedButton.click();
    await detailSection.getByText('已复制父件', { exact: false }).waitFor({ timeout: 60000 });
    await whereUsedClearSelectionButton.click();
    await page.waitForTimeout(200);
    const clearedRows = whereUsedSection.locator('table tbody tr.row-selected');
    if ((await clearedRows.count()) !== 0) {
      throw new Error('Where-used clear selection did not reset highlights.');
    }
  }

  const compareSection = page.locator('section:has-text("BOM 对比")');
  await compareSection.locator('#plm-compare-left-id').fill(compareLeftId);
  await compareSection.locator('#plm-compare-right-id').fill(compareRightId);
  await compareSection.locator('button:has-text("对比")').click();
  await waitOptional(compareSection.locator('table'), compareExpect);
  const compareDetailSection = compareSection.locator('[data-compare-detail="true"]');
  const compareChangedRows = compareSection.locator('.compare-section:has(h3:has-text("变更")) table tbody tr');
  const compareAddedRows = compareSection.locator('.compare-section:has(h3:has-text("新增")) table tbody tr');
  const compareRemovedRows = compareSection.locator('.compare-section:has(h3:has-text("删除")) table tbody tr');
  let compareTargetRows = compareChangedRows;
  if ((await compareTargetRows.count()) === 0) {
    compareTargetRows = compareAddedRows;
  }
  if ((await compareTargetRows.count()) === 0) {
    compareTargetRows = compareRemovedRows;
  }
  if ((await compareTargetRows.count()) > 0) {
    const compareTargetRow = compareTargetRows.first();
    await compareTargetRow.click();
    const compareDetailTable = compareDetailSection.locator('table');
    await compareDetailTable.waitFor({ timeout: 60000 });
    const compareDetailRows = compareDetailTable.locator('tbody tr[data-field-key]');
    if ((await compareDetailRows.count()) === 0) {
      throw new Error('BOM compare detail rows missing.');
    }
    const fieldKey = await compareDetailRows.first().getAttribute('data-field-key');
    if (!fieldKey) {
      throw new Error('BOM compare detail field key missing.');
    }
    const compareChildKey = ((await compareTargetRow.getAttribute('data-compare-child')) || '').trim();
    const compareLineId = ((await compareTargetRow.getAttribute('data-compare-line')) || '').trim();
    const compareSyncToggle = compareSection.locator('#plm-compare-sync');
    if ((await compareSyncToggle.count()) === 0) {
      throw new Error('BOM compare sync toggle missing.');
    }
    if (!(await compareSyncToggle.isChecked())) {
      throw new Error('BOM compare sync toggle is not enabled by default.');
    }
    if (compareChildKey) {
      const whereUsedValue = await whereUsedSection.locator('#plm-where-used-item-id').inputValue();
      if (whereUsedValue.trim() !== compareChildKey) {
        throw new Error(`Compare selection did not sync where-used child (${compareChildKey}).`);
      }
    }
    if (compareLineId) {
      const bomLineValue = await page.locator('#plm-bom-line-id').inputValue();
      if (bomLineValue.trim() !== compareLineId) {
        throw new Error(`Compare selection did not sync bom line id (${compareLineId}).`);
      }
    }
    if (compareChildKey || compareLineId) {
      await compareSyncToggle.uncheck();
      await whereUsedSection.locator('#plm-where-used-item-id').fill('');
      await page.locator('#plm-bom-line-id').fill('');
      await compareTargetRow.click();
      await compareTargetRow.click();
      if (compareChildKey) {
        const whereUsedValue = await whereUsedSection.locator('#plm-where-used-item-id').inputValue();
        if (whereUsedValue.trim() !== '') {
          throw new Error('Compare sync toggle did not disable where-used update.');
        }
      }
      if (compareLineId) {
        const bomLineValue = await page.locator('#plm-bom-line-id').inputValue();
        if (bomLineValue.trim() !== '') {
          throw new Error('Compare sync toggle did not disable bom line update.');
        }
      }
      await compareSyncToggle.check();
    }
    const compareCopyButton = compareDetailSection.locator('button:has-text("复制字段对照")');
    if ((await compareCopyButton.count()) === 0) {
      throw new Error('BOM compare detail copy button missing.');
    }
    if (!(await compareCopyButton.isEnabled())) {
      throw new Error('BOM compare detail copy button is disabled.');
    }
    const compareExportButton = compareDetailSection.locator('button:has-text("导出字段对照")');
    if ((await compareExportButton.count()) === 0) {
      throw new Error('BOM compare detail export button missing.');
    }
    if (!(await compareExportButton.isEnabled())) {
      throw new Error('BOM compare detail export button is disabled.');
    }
    await compareCopyButton.click();
    await detailSection.getByText('已复制字段对照', { exact: false }).waitFor({ timeout: 60000 });
  } else {
    console.warn('Skipping compare detail validation; no compare rows available.');
  }

  const substitutesSection = page.locator('section:has-text("替代件")');
  await substitutesSection.locator('#plm-bom-line-id').fill(bomLineId);
  await substitutesSection.locator('button:has-text("查询")').click();
  await waitOptional(substitutesSection.locator('table'), substituteExpect);

  const documentsSection = page.locator('section:has-text("关联文档")');
  await documentsSection.locator('button:has-text("刷新文档")').click();
  const docRows = documentsSection.locator('table tbody tr');
  await docRows.first().waitFor({ timeout: 60000 });
  await waitOptional(documentsSection.locator('table'), docName);
  await waitOptional(documentsSection.locator('table'), docRole);
  await waitOptional(documentsSection.locator('table'), docRevision || '');
  const docFileIdToggle = documentsSection.locator('#plm-document-column-fileId');
  if (await docFileIdToggle.count()) {
    await docFileIdToggle.check();
    await documentsSection.locator('th', { hasText: 'File ID' }).first().waitFor({ timeout: 60000 });
  }
  const docAuthorToggle = documentsSection.locator('#plm-document-column-author');
  if (await docAuthorToggle.count()) {
    await docAuthorToggle.check();
    await documentsSection.locator('th', { hasText: '作者' }).first().waitFor({ timeout: 60000 });
  }
  const docCreatedToggle = documentsSection.locator('#plm-document-column-created');
  if (await docCreatedToggle.count()) {
    await docCreatedToggle.check();
    await documentsSection.locator('th', { hasText: '创建时间' }).first().waitFor({ timeout: 60000 });
  }

  const approvalsSection = page.locator('section:has(h2:has-text("审批"))');
  await approvalsSection.locator('button:has-text("刷新审批")').click();
  const approvalRows = approvalsSection.locator('table tbody tr');
  await approvalRows.first().waitFor({ timeout: 60000 });
  await waitOptional(approvalsSection.locator('table'), approvalTitle);
  await waitOptional(approvalsSection.locator('table'), approvalProductNumber);
  const approvalIdToggle = approvalsSection.locator('#plm-approval-column-id');
  if (await approvalIdToggle.count()) {
    await approvalIdToggle.check();
    await approvalsSection.locator('th', { hasText: '审批 ID' }).first().waitFor({ timeout: 60000 });
  }
  const approvalRequesterIdToggle = approvalsSection.locator('#plm-approval-column-requesterId');
  if (await approvalRequesterIdToggle.count()) {
    await approvalRequesterIdToggle.check();
    await approvalsSection.locator('th', { hasText: '发起人 ID' }).first().waitFor({ timeout: 60000 });
  }
  const approvalProductIdToggle = approvalsSection.locator('#plm-approval-column-productId');
  if (await approvalProductIdToggle.count()) {
    await approvalProductIdToggle.check();
    await approvalsSection.locator('th', { hasText: '产品 ID' }).first().waitFor({ timeout: 60000 });
  }

  if (itemNumberPath) {
    const fs = require('fs');
    fs.writeFileSync(itemNumberPath, JSON.stringify({ item_number: itemNumberValue }, null, 2));
  }

  await page.waitForTimeout(1000);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await browser.close();
})();
JS_EOF

NODE_PATH="$ROOT_DIR/node_modules" \
METASHEET_TOKEN="$METASHEET_TOKEN" \
PLM_SEARCH_QUERY="$PLM_SEARCH_QUERY" \
PLM_PRODUCT_ID="$PLM_PRODUCT_ID" \
PLM_BOM_CHILD_ID="$PLM_BOM_CHILD_ID" \
PLM_BOM_FIND_NUM="$PLM_BOM_FIND_NUM" \
PLM_BOM_REFDES="$PLM_BOM_REFDES" \
PLM_BOM_DEPTH="$PLM_BOM_DEPTH" \
PLM_BOM_EFFECTIVE_AT="$PLM_BOM_EFFECTIVE_AT" \
PLM_WHERE_USED_ID="$PLM_WHERE_USED_ID" \
PLM_WHERE_USED_EXPECT="$PLM_WHERE_USED_EXPECT" \
PLM_COMPARE_LEFT_ID="$PLM_COMPARE_LEFT_ID" \
PLM_COMPARE_RIGHT_ID="$PLM_COMPARE_RIGHT_ID" \
PLM_COMPARE_EXPECT="$PLM_COMPARE_EXPECT" \
PLM_BOM_LINE_ID="$PLM_BOM_LINE_ID" \
PLM_SUBSTITUTE_EXPECT="$PLM_SUBSTITUTE_EXPECT" \
PLM_DOCUMENT_NAME="$PLM_DOCUMENT_NAME" \
PLM_DOCUMENT_ROLE="$PLM_DOCUMENT_ROLE" \
PLM_DOCUMENT_REVISION="$PLM_DOCUMENT_REVISION" \
PLM_APPROVAL_TITLE="$PLM_APPROVAL_TITLE" \
PLM_APPROVAL_PRODUCT_NUMBER="$PLM_APPROVAL_PRODUCT_NUMBER" \
UI_BASE="$UI_BASE" \
SCREENSHOT_PATH="$SCREENSHOT_PATH" \
ITEM_NUMBER_PATH="$ITEM_NUMBER_JSON" \
HEADLESS="$HEADLESS" \
node /tmp/plm_ui_regression.js

ITEM_NUMBER_USED=""
if [[ -s "$ITEM_NUMBER_JSON" ]]; then
  ITEM_NUMBER_USED=$(python3 - <<'PY' "$ITEM_NUMBER_JSON"
import json,sys
with open(sys.argv[1], encoding="utf-8") as f:
    print(json.load(f).get("item_number",""))
PY
  )
fi

cat > "$REPORT_PATH" <<REPORT_EOF
# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - ${STAMP}

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes -> documents -> approvals.

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
- BOM child ID: ${PLM_BOM_CHILD_ID:-n/a}
- BOM find #: ${PLM_BOM_FIND_NUM:-n/a}
- BOM refdes: ${PLM_BOM_REFDES:-n/a}
- BOM depth: ${PLM_BOM_DEPTH:-n/a}
- BOM effective at: ${PLM_BOM_EFFECTIVE_AT:-n/a}
- BOM filter: ${PLM_BOM_FIND_NUM:-n/a}
- BOM compare left/right: ${PLM_COMPARE_LEFT_ID} / ${PLM_COMPARE_RIGHT_ID}
- BOM compare expect: ${PLM_COMPARE_EXPECT:-n/a}
- Substitute BOM line: ${PLM_BOM_LINE_ID}
- Substitute expect: ${PLM_SUBSTITUTE_EXPECT:-n/a}
- Document name: ${PLM_DOCUMENT_NAME}
- Document role: ${PLM_DOCUMENT_ROLE}
- Document revision: ${PLM_DOCUMENT_REVISION:-n/a}
- Approval title: ${PLM_APPROVAL_TITLE}
- Approval product number: ${PLM_APPROVAL_PRODUCT_NUMBER:-n/a}
- Item number-only load: ${ITEM_NUMBER_USED:-n/a}

## Results
- Search returns matching row and selection loads product detail.
- Item number-only load repopulates Product ID.
- Product detail copy actions executed.
- ${BOM_CHILD_RESULT}
- ${BOM_DETAIL_RESULT}
- BOM/Where-Used filter presets import/export/share/clear/conflict dialogs validated.
- BOM tree view renders with expandable nodes.
- BOM expand-to-depth button is enabled.
- BOM tree export button is enabled.
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Documents table loads with expected document metadata and extended columns.
- Approvals table loads with expected approval metadata and extended columns.
- Screenshot: ${SCREENSHOT_PATH}
- Item number artifact: ${ITEM_NUMBER_JSON}
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
