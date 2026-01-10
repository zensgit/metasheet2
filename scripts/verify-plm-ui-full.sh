#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

OUTPUT_DIR="${OUTPUT_DIR:-artifacts}"
REPORT_DIR="${REPORT_DIR:-docs}"
RUN_STAMP="${STAMP:-$(date +%Y%m%d_%H%M%S)}"
BOM_STAMP="${BOM_STAMP:-$RUN_STAMP}"
UI_STAMP="${UI_STAMP:-$RUN_STAMP}"

PLM_CLEANUP="${PLM_CLEANUP:-false}"
PLM_BASE_URL="${PLM_BASE_URL:-http://127.0.0.1:7910}"
PLM_TENANT_ID="${PLM_TENANT_ID:-tenant-1}"
PLM_ORG_ID="${PLM_ORG_ID:-org-1}"
PLM_USERNAME="${PLM_USERNAME:-admin}"
PLM_PASSWORD="${PLM_PASSWORD:-admin}"
PLM_ITEM_TYPE="${PLM_ITEM_TYPE:-Part}"

BOM_JSON="$OUTPUT_DIR/plm-bom-tools-${BOM_STAMP}.json"
BOM_MD="$OUTPUT_DIR/plm-bom-tools-${BOM_STAMP}.md"
UI_REPORT="$REPORT_DIR/verification-plm-ui-regression-${UI_STAMP}.md"
UI_SCREENSHOT="$OUTPUT_DIR/plm-ui-regression-${UI_STAMP}.png"
FULL_REPORT="$REPORT_DIR/verification-plm-ui-full-${RUN_STAMP}.md"

mkdir -p "$OUTPUT_DIR" "$REPORT_DIR"

echo "[1/2] Running PLM BOM tools seed..."
STAMP="$BOM_STAMP" OUTPUT_DIR="$OUTPUT_DIR" OUTPUT_BASENAME="plm-bom-tools" PLM_CLEANUP="false" \
  bash scripts/verify-plm-bom-tools.sh

if [[ ! -f "$BOM_JSON" ]]; then
  echo "Expected BOM tools JSON not found: $BOM_JSON" >&2
  exit 1
fi

if [[ ! -f "$BOM_MD" ]]; then
  echo "Expected BOM tools report not found: $BOM_MD" >&2
  exit 1
fi

echo "[2/2] Running PLM UI regression..."
STAMP="$UI_STAMP" OUTPUT_DIR="$OUTPUT_DIR" REPORT_DIR="$REPORT_DIR" PLM_BOM_TOOLS_JSON="$BOM_JSON" \
  bash scripts/verify-plm-ui-regression.sh

cleanup_status="skipped"
if [[ "$PLM_CLEANUP" == "true" ]]; then
  echo "Cleaning up PLM fixtures..."
  PLM_TOKEN="${PLM_API_TOKEN:-${PLM_AUTH_TOKEN:-${PLM_TOKEN:-}}}"
  if [[ -z "$PLM_TOKEN" ]]; then
    PLM_TOKEN=$(curl -sS -X POST "$PLM_BASE_URL/api/v1/auth/login" \
      -H "Content-Type: application/json" \
      -H "x-tenant-id: $PLM_TENANT_ID" \
      -H "x-org-id: $PLM_ORG_ID" \
      -d "{\"username\":\"$PLM_USERNAME\",\"password\":\"$PLM_PASSWORD\",\"tenant_id\":\"$PLM_TENANT_ID\",\"org_id\":\"$PLM_ORG_ID\"}" \
      | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access_token",""))' || true)
  fi

  if [[ -z "$PLM_TOKEN" ]]; then
    cleanup_status="failed (token)"
  else
    mapfile -t fixture_ids < <(python3 - <<'PY' "$BOM_JSON"
import json
import sys
path = sys.argv[1]
fix = {}
try:
    data = json.load(open(path, encoding='utf-8'))
    fix = data.get('fixtures') or {}
except Exception:
    fix = {}
keys = [
    'parent_a',
    'parent_b',
    'child_x',
    'child_y',
    'child_z',
    'substitute',
    'bom_line_id',
    'substitute_rel_id',
]
for key in keys:
    print(fix.get(key, ''))
PY
    )

    PARENT_A="${fixture_ids[0]:-}"
    PARENT_B="${fixture_ids[1]:-}"
    CHILD_X="${fixture_ids[2]:-}"
    CHILD_Y="${fixture_ids[3]:-}"
    CHILD_Z="${fixture_ids[4]:-}"
    SUB_PART="${fixture_ids[5]:-}"
    BOM_LINE_ID="${fixture_ids[6]:-}"
    SUB_REL_ID="${fixture_ids[7]:-}"

    delete_substitute() {
      local bom_line_id="$1"
      local substitute_id="$2"
      if [[ -z "$bom_line_id" || -z "$substitute_id" ]]; then
        return 0
      fi
      curl -sS -X DELETE "$PLM_BASE_URL/api/v1/bom/$bom_line_id/substitutes/$substitute_id" \
        -H "Authorization: Bearer $PLM_TOKEN" \
        -H "x-tenant-id: $PLM_TENANT_ID" \
        -H "x-org-id: $PLM_ORG_ID" >/dev/null || true
    }

    delete_bom_child() {
      local parent_id="$1"
      local child_id="$2"
      if [[ -z "$parent_id" || -z "$child_id" ]]; then
        return 0
      fi
      curl -sS -X DELETE "$PLM_BASE_URL/api/v1/bom/$parent_id/children/$child_id" \
        -H "Authorization: Bearer $PLM_TOKEN" \
        -H "x-tenant-id: $PLM_TENANT_ID" \
        -H "x-org-id: $PLM_ORG_ID" >/dev/null || true
    }

    delete_item() {
      local item_id="$1"
      if [[ -z "$item_id" ]]; then
        return 0
      fi
      curl -sS -X POST "$PLM_BASE_URL/api/v1/aml/apply" \
        -H "Authorization: Bearer $PLM_TOKEN" \
        -H "x-tenant-id: $PLM_TENANT_ID" \
        -H "x-org-id: $PLM_ORG_ID" \
        -H 'content-type: application/json' \
        -d "{\"type\":\"$PLM_ITEM_TYPE\",\"action\":\"delete\",\"id\":\"$item_id\"}" >/dev/null || true
    }

    delete_substitute "$BOM_LINE_ID" "$SUB_REL_ID"
    delete_bom_child "$PARENT_A" "$CHILD_X"
    delete_bom_child "$PARENT_A" "$CHILD_Y"
    delete_bom_child "$PARENT_B" "$CHILD_X"
    delete_bom_child "$PARENT_B" "$CHILD_Z"
    delete_item "$PARENT_A"
    delete_item "$PARENT_B"
    delete_item "$CHILD_X"
    delete_item "$CHILD_Y"
    delete_item "$CHILD_Z"
    delete_item "$SUB_PART"

    cleanup_status="done"
  fi
fi

cat > "$FULL_REPORT" <<REPORT_EOF
# Verification: PLM UI Full Regression - ${RUN_STAMP}

## Goal
Run BOM tools seed + PLM UI regression in a single workflow.

## Environment
- PLM base: ${PLM_BASE_URL}
- Tenant/org: ${PLM_TENANT_ID} / ${PLM_ORG_ID}

## Steps
1. BOM tools seed
   - Report: ${BOM_MD}
   - JSON: ${BOM_JSON}
2. UI regression
   - Report: ${UI_REPORT}
   - Screenshot: ${UI_SCREENSHOT}

## Cleanup
- PLM_CLEANUP: ${PLM_CLEANUP}
- Status: ${cleanup_status}
REPORT_EOF

echo "Report: $FULL_REPORT"
