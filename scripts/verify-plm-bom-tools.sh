#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

PLM_BASE_URL="${PLM_BASE_URL:-http://127.0.0.1:7910}"
PLM_TENANT_ID="${PLM_TENANT_ID:-tenant-1}"
PLM_ORG_ID="${PLM_ORG_ID:-org-1}"
PLM_USERNAME="${PLM_USERNAME:-admin}"
PLM_PASSWORD="${PLM_PASSWORD:-admin}"
PLM_ITEM_TYPE="${PLM_ITEM_TYPE:-Part}"

OUTPUT_DIR="${OUTPUT_DIR:-artifacts}"
OUTPUT_BASENAME="${OUTPUT_BASENAME:-plm-bom-tools}"
STAMP="${STAMP:-$(date +%Y%m%d_%H%M%S)}"

OUTPUT_JSON="$OUTPUT_DIR/${OUTPUT_BASENAME}-${STAMP}.json"
OUTPUT_MD="$OUTPUT_DIR/${OUTPUT_BASENAME}-${STAMP}.md"

mkdir -p "$OUTPUT_DIR"

PLM_TOKEN="${PLM_API_TOKEN:-${PLM_AUTH_TOKEN:-${PLM_TOKEN:-}}}"
if [[ -z "$PLM_TOKEN" ]]; then
  PLM_TOKEN=$(curl -sS -X POST "$PLM_BASE_URL/api/v1/auth/login" \
    -H 'content-type: application/json' \
    -H "x-tenant-id: $PLM_TENANT_ID" \
    -H "x-org-id: $PLM_ORG_ID" \
    -d "{\"tenant_id\":\"$PLM_TENANT_ID\",\"username\":\"$PLM_USERNAME\",\"password\":\"$PLM_PASSWORD\",\"org_id\":\"$PLM_ORG_ID\"}" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access_token",""))' || true)
fi

if [[ -z "$PLM_TOKEN" ]]; then
  echo "Failed to acquire PLM token" >&2
  exit 1
fi

AUTH=(-H "Authorization: Bearer $PLM_TOKEN")
TENANT_HEADERS=(-H "x-tenant-id: $PLM_TENANT_ID" -H "x-org-id: $PLM_ORG_ID")
JSON_HEADERS=(-H 'content-type: application/json')

create_part() {
  local item_number="$1"
  local name="$2"
  local payload
  payload=$(printf '{"type":"%s","action":"add","properties":{"item_number":"%s","name":"%s"}}' \
    "$PLM_ITEM_TYPE" "$item_number" "$name")
  curl -sS -X POST "$PLM_BASE_URL/api/v1/aml/apply" \
    "${TENANT_HEADERS[@]}" "${AUTH[@]}" "${JSON_HEADERS[@]}" \
    -d "$payload" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))'
}

add_bom_child() {
  local parent_id="$1"
  local child_id="$2"
  local quantity="$3"
  curl -sS -X POST "$PLM_BASE_URL/api/v1/bom/$parent_id/children" \
    "${TENANT_HEADERS[@]}" "${AUTH[@]}" "${JSON_HEADERS[@]}" \
    -d "{\"child_id\":\"$child_id\",\"quantity\":$quantity,\"uom\":\"EA\"}"
}

add_substitute() {
  local bom_line_id="$1"
  local substitute_id="$2"
  curl -sS -X POST "$PLM_BASE_URL/api/v1/bom/$bom_line_id/substitutes" \
    "${TENANT_HEADERS[@]}" "${AUTH[@]}" "${JSON_HEADERS[@]}" \
    -d "{\"substitute_item_id\":\"$substitute_id\",\"properties\":{\"rank\":1,\"note\":\"seed\"}}"
}

TS="$(date +%s)"

PARENT_A_ITEM="MS-BOM-A-$TS"
PARENT_B_ITEM="MS-BOM-B-$TS"
CHILD_X_ITEM="MS-BOM-X-$TS"
CHILD_Y_ITEM="MS-BOM-Y-$TS"
CHILD_Z_ITEM="MS-BOM-Z-$TS"
SUB_ITEM="MS-BOM-S-$TS"

PARENT_A_ID="$(create_part "$PARENT_A_ITEM" "MetaSheet BOM Parent A $TS")"
PARENT_B_ID="$(create_part "$PARENT_B_ITEM" "MetaSheet BOM Parent B $TS")"
CHILD_X_ID="$(create_part "$CHILD_X_ITEM" "MetaSheet BOM Child X $TS")"
CHILD_Y_ID="$(create_part "$CHILD_Y_ITEM" "MetaSheet BOM Child Y $TS")"
CHILD_Z_ID="$(create_part "$CHILD_Z_ITEM" "MetaSheet BOM Child Z $TS")"
SUB_ID="$(create_part "$SUB_ITEM" "MetaSheet BOM Substitute $TS")"

if [[ -z "$PARENT_A_ID" || -z "$PARENT_B_ID" || -z "$CHILD_X_ID" || -z "$CHILD_Y_ID" || -z "$CHILD_Z_ID" || -z "$SUB_ID" ]]; then
  echo "Failed to create BOM fixture items" >&2
  exit 1
fi

BOM_AX_RESP="$(add_bom_child "$PARENT_A_ID" "$CHILD_X_ID" 2)"
BOM_AX_LINE_ID="$(echo "$BOM_AX_RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("relationship_id",""))')"
if [[ -z "$BOM_AX_LINE_ID" ]]; then
  echo "Failed to create BOM line for parent A -> child X" >&2
  echo "$BOM_AX_RESP" >&2
  exit 1
fi

add_bom_child "$PARENT_A_ID" "$CHILD_Y_ID" 1 >/dev/null
add_bom_child "$PARENT_B_ID" "$CHILD_X_ID" 3 >/dev/null
add_bom_child "$PARENT_B_ID" "$CHILD_Z_ID" 4 >/dev/null

SUB_ADD_RESP="$(add_substitute "$BOM_AX_LINE_ID" "$SUB_ID")"
SUB_REL_ID="$(echo "$SUB_ADD_RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("substitute_id",""))')"

WHERE_USED_RESP="$(curl -sS "$PLM_BASE_URL/api/v1/bom/$CHILD_X_ID/where-used?recursive=false" "${TENANT_HEADERS[@]}" "${AUTH[@]}")"
COMPARE_QUERY="left_type=item&left_id=$PARENT_A_ID&right_type=item&right_id=$PARENT_B_ID&max_levels=5&include_substitutes=true"
COMPARE_RESP="$(curl -sS "$PLM_BASE_URL/api/v1/bom/compare?$COMPARE_QUERY" "${TENANT_HEADERS[@]}" "${AUTH[@]}")"
SUBS_RESP="$(curl -sS "$PLM_BASE_URL/api/v1/bom/$BOM_AX_LINE_ID/substitutes" "${TENANT_HEADERS[@]}" "${AUTH[@]}")"

python3 - <<'PY' "$OUTPUT_JSON" "$STAMP" "$PLM_BASE_URL" "$PLM_TENANT_ID" "$PLM_ORG_ID" \
  "$PARENT_A_ID" "$PARENT_B_ID" "$CHILD_X_ID" "$CHILD_Y_ID" "$CHILD_Z_ID" "$SUB_ID" \
  "$BOM_AX_LINE_ID" "$SUB_REL_ID" "$WHERE_USED_RESP" "$COMPARE_QUERY" "$COMPARE_RESP" \
  "$SUBS_RESP" "$PARENT_A_ITEM" "$PARENT_B_ITEM" "$CHILD_X_ITEM" "$CHILD_Y_ITEM" "$CHILD_Z_ITEM" "$SUB_ITEM"
import json
import sys
from datetime import datetime

(
  output_path,
  stamp,
  base_url,
  tenant,
  org,
  parent_a,
  parent_b,
  child_x,
  child_y,
  child_z,
  substitute,
  bom_line_id,
  substitute_rel_id,
  where_used_resp,
  compare_query,
  compare_resp,
  subs_resp,
  parent_a_num,
  parent_b_num,
  child_x_num,
  child_y_num,
  child_z_num,
  sub_num,
) = sys.argv[1:]

def safe_json(payload: str):
    try:
        return json.loads(payload)
    except Exception:
        return {"raw": payload}

payload = {
    "generated_at": datetime.utcnow().isoformat() + "Z",
    "stamp": stamp,
    "plm": {
        "base_url": base_url,
        "tenant_id": tenant,
        "org_id": org,
    },
    "fixtures": {
        "parent_a": parent_a,
        "parent_b": parent_b,
        "child_x": child_x,
        "child_y": child_y,
        "child_z": child_z,
        "substitute": substitute,
        "bom_line_id": bom_line_id,
        "substitute_rel_id": substitute_rel_id,
        "item_numbers": {
            "parent_a": parent_a_num,
            "parent_b": parent_b_num,
            "child_x": child_x_num,
            "child_y": child_y_num,
            "child_z": child_z_num,
            "substitute": sub_num,
        },
    },
    "where_used": {
        "request": {
            "item_id": child_x,
            "recursive": False,
        },
        "data": safe_json(where_used_resp),
    },
    "bom_compare": {
        "request": {
            "query": compare_query,
        },
        "data": safe_json(compare_resp),
    },
    "substitutes": {
        "request": {
            "bom_line_id": bom_line_id,
        },
        "data": safe_json(subs_resp),
    },
}

with open(output_path, "w", encoding="utf-8") as f:
    json.dump(payload, f, indent=2, ensure_ascii=True)
PY

python3 - <<'PY' "$OUTPUT_MD" "$OUTPUT_JSON" "$STAMP" "$PARENT_A_ITEM" "$PARENT_B_ITEM" "$CHILD_X_ITEM" "$BOM_AX_LINE_ID"
import json
import sys

md_path = sys.argv[1]
json_path = sys.argv[2]
stamp = sys.argv[3]
parent_a_num = sys.argv[4]
parent_b_num = sys.argv[5]
child_x_num = sys.argv[6]
bom_line = sys.argv[7]

with open(json_path, encoding="utf-8") as f:
    payload = json.load(f)

where_used = payload.get("where_used", {}).get("data") or {}
compare = payload.get("bom_compare", {}).get("data") or {}
subs = payload.get("substitutes", {}).get("data") or {}

with open(md_path, "w", encoding="utf-8") as f:
    f.write(f"# Verification: PLM BOM Tools Seed - {stamp}\n\n")
    f.write("## Fixtures\n")
    f.write(f"- Parent A: {parent_a_num}\n")
    f.write(f"- Parent B: {parent_b_num}\n")
    f.write(f"- Child X: {child_x_num}\n")
    f.write(f"- BOM line (A -> X): {bom_line}\n\n")
    f.write("## Where-Used (non-recursive)\n")
    f.write(f"- count: {where_used.get('count','')}\n\n")
    f.write("## BOM Compare\n")
    summary = (compare.get("summary") if isinstance(compare, dict) else None) or {}
    if summary:
        f.write(f"- added: {summary.get('added','')}\n")
        f.write(f"- removed: {summary.get('removed','')}\n")
        f.write(f"- changed: {summary.get('changed','')}\n")
    f.write("\n")
    f.write("## Substitutes\n")
    f.write(f"- count: {subs.get('count','')}\n")
    f.write("\n")
    f.write(f"JSON: {json_path}\n")
PY

echo "Report: $OUTPUT_MD"
