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
AUTO_START="${AUTO_START:-false}"
RBAC_BYPASS="${RBAC_BYPASS:-true}"
JWT_SECRET_VALUE="${JWT_SECRET:-fallback-development-secret-change-in-production}"
METASHEET_AUTH_TOKEN="${METASHEET_AUTH_TOKEN:-}"
TSX_BIN="${TSX_BIN:-$ROOT_DIR/node_modules/.bin/tsx}"
OUTPUT_DIR="${OUTPUT_DIR:-artifacts}"
OUTPUT_BASENAME="${OUTPUT_BASENAME:-plm-bom-tools}"
STAMP="${STAMP:-$(date +%Y%m%d_%H%M)}"

if [[ ! -x "$TSX_BIN" ]]; then
  TSX_BIN="tsx"
fi
if ! command -v "$TSX_BIN" >/dev/null 2>&1; then
  echo "tsx binary not found. Set TSX_BIN to the local tsx path." >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
report_json="$OUTPUT_DIR/${OUTPUT_BASENAME}-${STAMP}.json"
report_md="$OUTPUT_DIR/${OUTPUT_BASENAME}-${STAMP}.md"

if ! curl -fsS "${API_BASE}/health" >/dev/null 2>&1; then
  if [[ "$AUTO_START" != "true" ]]; then
    echo "Core backend not running at ${API_BASE}." >&2
    echo "Start it or re-run with AUTO_START=true." >&2
    exit 1
  fi

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
    pnpm --filter @metasheet/core-backend dev:core > artifacts/plm-bom-tools-backend.log 2>&1 &
  BACK_PID=$!

  for _ in {1..30}; do
    if curl -fsS "${API_BASE}/health" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  if ! curl -fsS "${API_BASE}/health" >/dev/null 2>&1; then
    echo "Backend failed to start (see artifacts/plm-bom-tools-backend.log)" >&2
    kill "$BACK_PID" >/dev/null 2>&1 || true
    exit 1
  fi
else
  BACK_PID=""
fi

cleanup() {
  if [[ -n "${BACK_PID}" ]]; then
    kill "${BACK_PID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

METASHEET_TOKEN="$METASHEET_AUTH_TOKEN"
if [[ -z "$METASHEET_TOKEN" ]]; then
  METASHEET_TOKEN=$(curl -sS "${API_BASE}/api/auth/dev-token" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' || true)
fi

if [[ -z "$METASHEET_TOKEN" ]]; then
  token_json="$OUTPUT_DIR/${OUTPUT_BASENAME}-token.json"
  token_err="$OUTPUT_DIR/${OUTPUT_BASENAME}-token.err"
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

PLM_TOKEN=$(curl -sS -X POST "$PLM_BASE_URL/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: $PLM_TENANT_ID" \
  -H "x-org-id: $PLM_ORG_ID" \
  -d "{\"username\":\"$PLM_USERNAME\",\"password\":\"$PLM_PASSWORD\",\"tenant_id\":\"$PLM_TENANT_ID\",\"org_id\":\"$PLM_ORG_ID\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access_token",""))')

if [[ -z "$PLM_TOKEN" ]]; then
  echo "Failed to obtain PLM token." >&2
  exit 1
fi

HEADERS=(-H "x-tenant-id: $PLM_TENANT_ID" -H "x-org-id: $PLM_ORG_ID" -H "Authorization: Bearer $PLM_TOKEN")

create_part() {
  local item_number="$1"
  local name="$2"
  curl -sS -X POST "$PLM_BASE_URL/api/v1/aml/apply" "${HEADERS[@]}" \
    -H 'content-type: application/json' \
    -d "{\"type\":\"Part\",\"action\":\"add\",\"properties\":{\"item_number\":\"$item_number\",\"name\":\"$name\"}}" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))'
}

add_child() {
  local parent_id="$1"
  local child_id="$2"
  local payload="$3"
  curl -sS -X POST "$PLM_BASE_URL/api/v1/bom/$parent_id/children" "${HEADERS[@]}" \
    -H 'content-type: application/json' \
    -d "$payload"
}

get_bom_line_id() {
  local parent_id="$1"
  local child_id="$2"
  local attempt=0
  local response=""
  local found=""
  while [[ $attempt -lt 5 ]]; do
    response=$(curl -sS "$PLM_BASE_URL/api/v1/bom/$parent_id/tree?depth=1" "${HEADERS[@]}" || true)
    if [[ -n "$response" ]]; then
      found=$(BOM_JSON="$response" python3 - <<'PY' "$child_id"
import json,os,sys
target=sys.argv[1]
raw=os.environ.get("BOM_JSON","")
try:
    data=json.loads(raw)
except Exception:
    print("")
    raise SystemExit(0)
for entry in data.get("children", []) or []:
    rel=entry.get("relationship") or {}
    child=entry.get("child") or {}
    if child.get("id") == target:
        print(rel.get("id") or "")
        raise SystemExit(0)
print("")
PY
      )
      if [[ -n "$found" ]]; then
        echo "$found"
        return 0
      fi
    fi
    attempt=$((attempt + 1))
    sleep 0.4
  done
  echo ""
}

TS="$(date +%s)"
PARENT_A=$(create_part "UI-CMP-A-$TS" "UI Compare A")
PARENT_B=$(create_part "UI-CMP-B-$TS" "UI Compare B")
CHILD_X=$(create_part "UI-CMP-X-$TS" "UI Child X")
CHILD_Y=$(create_part "UI-CMP-Y-$TS" "UI Child Y")
CHILD_Z=$(create_part "UI-CMP-Z-$TS" "UI Child Z")
SUB_PART=$(create_part "UI-CMP-S-$TS" "UI Substitute")

if [[ -z "$PARENT_A" || -z "$PARENT_B" || -z "$CHILD_X" || -z "$CHILD_Y" || -z "$CHILD_Z" || -z "$SUB_PART" ]]; then
  echo "Failed to create sample items in PLM." >&2
  exit 1
fi

add_child "$PARENT_A" "$CHILD_X" "{\"child_id\":\"$CHILD_X\",\"quantity\":1,\"uom\":\"EA\",\"find_num\":\"010\"}" >/dev/null
add_child "$PARENT_A" "$CHILD_Y" "{\"child_id\":\"$CHILD_Y\",\"quantity\":1,\"uom\":\"EA\"}" >/dev/null

add_child "$PARENT_B" "$CHILD_X" "{\"child_id\":\"$CHILD_X\",\"quantity\":2,\"uom\":\"EA\",\"find_num\":\"020\",\"refdes\":\"R1,R2\"}" >/dev/null
add_child "$PARENT_B" "$CHILD_Z" "{\"child_id\":\"$CHILD_Z\",\"quantity\":1,\"uom\":\"EA\"}" >/dev/null

BOM_LINE_X=$(get_bom_line_id "$PARENT_B" "$CHILD_X")
if [[ -z "$BOM_LINE_X" ]]; then
  echo "Failed to resolve BOM line for CHILD_X." >&2
  exit 1
fi

SUB_RESP=$(curl -sS -X POST "$PLM_BASE_URL/api/v1/bom/$BOM_LINE_X/substitutes" "${HEADERS[@]}" \
  -H 'content-type: application/json' \
  -d "{\"substitute_item_id\":\"$SUB_PART\",\"properties\":{\"rank\":1,\"note\":\"alt\"}}")
SUB_REL_ID=$(echo "$SUB_RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("substitute_id",""))')
if [[ -z "$SUB_REL_ID" ]]; then
  echo "Failed to add substitute: $SUB_RESP" >&2
  exit 1
fi

payload_where=$(python3 - <<PY
import json
print(json.dumps({
  "operation": "where_used",
  "itemId": "$CHILD_X",
  "recursive": True,
  "maxLevels": 5
}))
PY
)

payload_compare=$(python3 - <<PY
import json
print(json.dumps({
  "operation": "bom_compare",
  "leftId": "$PARENT_A",
  "rightId": "$PARENT_B",
  "leftType": "item",
  "rightType": "item",
  "maxLevels": 10,
  "compareMode": "summarized"
}))
PY
)

payload_subs=$(python3 - <<PY
import json
print(json.dumps({
  "operation": "substitutes",
  "bomLineId": "$BOM_LINE_X"
}))
PY
)

has_where_used_parents() {
  python3 - <<'PY' "$1"
import json,sys
raw = sys.argv[1]
try:
    data = json.loads(raw)
except Exception:
    raise SystemExit(1)
parents = ((data.get("data") or {}).get("parents") or [])
raise SystemExit(0 if parents else 1)
PY
}

resp_where=""
for _ in {1..5}; do
  resp_where=$(curl -sS -X POST "${API_BASE}/api/federation/plm/query" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $METASHEET_TOKEN" \
    -d "$payload_where")
  if has_where_used_parents "$resp_where"; then
    break
  fi
  sleep 0.6
done
if ! has_where_used_parents "$resp_where"; then
  echo "where_used returned no parents" >&2
  exit 1
fi

resp_compare=$(curl -sS -X POST "${API_BASE}/api/federation/plm/query" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $METASHEET_TOKEN" \
  -d "$payload_compare")

resp_subs=$(curl -sS -X POST "${API_BASE}/api/federation/plm/query" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $METASHEET_TOKEN" \
  -d "$payload_subs")

python3 - <<'PY' "$resp_where" "$resp_compare" "$resp_subs" "$report_json"
import json,sys
where_raw, compare_raw, subs_raw, out = sys.argv[1:5]
def load(raw):
    try:
        return json.loads(raw)
    except Exception:
        return {"parse_error": raw}
data = {
  "where_used": load(where_raw),
  "bom_compare": load(compare_raw),
  "substitutes": load(subs_raw),
}
with open(out, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
PY

python3 - <<'PY' "$report_json"
import json,sys
data=json.load(open(sys.argv[1], encoding="utf-8"))
where_data = (data.get("where_used") or {}).get("data") or {}
compare_data = (data.get("bom_compare") or {}).get("data") or {}
subs_data = (data.get("substitutes") or {}).get("data") or {}

parents = where_data.get("parents") or []
if not parents:
    raise SystemExit("where_used returned no parents")
summary = compare_data.get("summary") or {}
if summary.get("added", 0) < 1 or summary.get("removed", 0) < 1:
    raise SystemExit("bom_compare summary missing expected added/removed")
if summary.get("changed", 0) < 1:
    raise SystemExit("bom_compare summary missing changed")
subs = subs_data.get("substitutes") or []
if not subs:
    raise SystemExit("substitutes returned empty list")
print("PLM BOM tools verification: OK")
PY

python3 - <<'PY' "$report_json" "$report_md" "$API_BASE" "$PLM_BASE_URL" "$PARENT_A" "$PARENT_B" "$CHILD_X" "$CHILD_Y" "$CHILD_Z" "$SUB_PART" "$BOM_LINE_X"
import json,sys
report_json, report_md, api_base, plm_base = sys.argv[1:5]
parent_a, parent_b, child_x, child_y, child_z, sub_part, bom_line = sys.argv[5:12]

data=json.load(open(report_json, encoding="utf-8"))
where_data = (data.get("where_used") or {}).get("data") or {}
compare_data = (data.get("bom_compare") or {}).get("data") or {}
subs_data = (data.get("substitutes") or {}).get("data") or {}

summary = compare_data.get("summary") or {}
where_count = where_data.get("count") or 0
subs_count = subs_data.get("count")
if subs_count is None:
    subs_count = len(subs_data.get("substitutes") or [])

lines = [
    "# PLM BOM Tools Verification Report",
    "",
    "## Environment",
    f"- MetaSheet API: {api_base}",
    f"- PLM Base URL: {plm_base}",
    "",
    "## Test Data",
    f"- Parent A: {parent_a}",
    f"- Parent B: {parent_b}",
    f"- Child X: {child_x}",
    f"- Child Y: {child_y}",
    f"- Child Z: {child_z}",
    f"- Substitute Part: {sub_part}",
    f"- BOM Line ID (Child X): {bom_line}",
    "",
    "## Results",
    f"- Where-Used count: {where_count}",
    f"- BOM Compare summary: added={summary.get('added', 0)}, removed={summary.get('removed', 0)}, changed={summary.get('changed', 0)}, major={summary.get('changed_major', 0)}, minor={summary.get('changed_minor', 0)}, info={summary.get('changed_info', 0)}",
    f"- Substitutes count: {subs_count}",
    "",
    "## Artifacts",
    f"- JSON report: {report_json}",
    "",
    "Status: PASS",
]

with open(report_md, "w", encoding="utf-8") as f:
    f.write("\n".join(lines))
PY

echo "$report_json"
echo "$report_md"
