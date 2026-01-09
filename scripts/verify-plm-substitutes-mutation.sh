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
REPORT_DIR="${REPORT_DIR:-docs}"
STAMP="${STAMP:-$(date +%Y%m%d_%H%M%S)}"

if [[ ! -x "$TSX_BIN" ]]; then
  TSX_BIN="tsx"
fi
if ! command -v "$TSX_BIN" >/dev/null 2>&1; then
  echo "tsx binary not found. Set TSX_BIN to the local tsx path." >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR" "$REPORT_DIR"
report_json="$OUTPUT_DIR/plm-substitutes-mutation-${STAMP}.json"
report_md="$REPORT_DIR/verification-plm-substitutes-mutation-${STAMP}.md"

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
    pnpm --filter @metasheet/core-backend dev:core > "$OUTPUT_DIR/plm-substitutes-mutation-backend.log" 2>&1 &
  BACK_PID=$!

  for _ in {1..30}; do
    if curl -fsS "${API_BASE}/health" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  if ! curl -fsS "${API_BASE}/health" >/dev/null 2>&1; then
    echo "Backend failed to start (see $OUTPUT_DIR/plm-substitutes-mutation-backend.log)" >&2
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
  token_json="$OUTPUT_DIR/plm-substitutes-mutation-token.json"
  token_err="$OUTPUT_DIR/plm-substitutes-mutation-token.err"
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
  curl -sS -X POST "$PLM_BASE_URL/api/v1/bom/$parent_id/children" "${HEADERS[@]}" \
    -H 'content-type: application/json' \
    -d "{\"child_id\":\"$child_id\",\"quantity\":1,\"uom\":\"EA\"}"
}

get_bom_line_id() {
  local parent_id="$1"
  local child_id="$2"
  local response=""
  local found=""
  for _ in {1..5}; do
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
    sleep 0.4
  done
  echo ""
}

TS="$(date +%s)"
PARENT=$(create_part "UI-SUB-P-$TS" "UI Sub Parent")
CHILD=$(create_part "UI-SUB-C-$TS" "UI Sub Child")
SUB_PART=$(create_part "UI-SUB-S-$TS" "UI Substitute")

if [[ -z "$PARENT" || -z "$CHILD" || -z "$SUB_PART" ]]; then
  echo "Failed to create sample items in PLM." >&2
  exit 1
fi

add_child "$PARENT" "$CHILD" >/dev/null
BOM_LINE_ID=$(get_bom_line_id "$PARENT" "$CHILD")
if [[ -z "$BOM_LINE_ID" ]]; then
  echo "Failed to resolve BOM line id." >&2
  exit 1
fi

payload_add=$(python3 - <<PY
import json
print(json.dumps({
  "operation": "substitutes_add",
  "bomLineId": "$BOM_LINE_ID",
  "substituteItemId": "$SUB_PART",
  "properties": {"rank": 1, "note": "alt"}
}))
PY
)

resp_add=$(curl -sS -X POST "${API_BASE}/api/federation/plm/mutate" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $METASHEET_TOKEN" \
  -d "$payload_add")

payload_list=$(python3 - <<PY
import json
print(json.dumps({
  "operation": "substitutes",
  "bomLineId": "$BOM_LINE_ID"
}))
PY
)

resp_list=$(curl -sS -X POST "${API_BASE}/api/federation/plm/query" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $METASHEET_TOKEN" \
  -d "$payload_list")

substitute_id=$(python3 - <<'PY' "$resp_add" "$resp_list" "$SUB_PART"
import json,sys
add_raw, list_raw, sub_part_id = sys.argv[1:4]
sub_id = ""
try:
    add = json.loads(add_raw)
    sub_id = (add.get("data") or {}).get("substitute_id") or ""
except Exception:
    sub_id = ""
if not sub_id:
    try:
        listed = json.loads(list_raw)
        subs = ((listed.get("data") or {}).get("substitutes") or [])
        for entry in subs:
            part = entry.get("substitute_part") or {}
            if part.get("id") != sub_part_id:
                continue
            sub_id = entry.get("id") or entry.get("relationship", {}).get("id") or ""
            if sub_id:
                break
    except Exception:
        pass
print(sub_id)
PY
)

if [[ -z "$substitute_id" ]]; then
  echo "Failed to resolve substitute id from mutation/list response." >&2
  echo "$resp_add" >&2
  exit 1
fi

payload_remove=$(python3 - <<PY
import json
print(json.dumps({
  "operation": "substitutes_remove",
  "bomLineId": "$BOM_LINE_ID",
  "substituteId": "$substitute_id"
}))
PY
)

resp_remove=$(curl -sS -X POST "${API_BASE}/api/federation/plm/mutate" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $METASHEET_TOKEN" \
  -d "$payload_remove")

resp_list_after=$(curl -sS -X POST "${API_BASE}/api/federation/plm/query" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $METASHEET_TOKEN" \
  -d "$payload_list")

python3 - <<'PY' "$resp_add" "$resp_list" "$resp_remove" "$resp_list_after" "$report_json" "$BOM_LINE_ID" "$SUB_PART" "$substitute_id"
import json,sys
add_raw, list_raw, remove_raw, list_after_raw, out, bom_line_id, sub_part_id, sub_id = sys.argv[1:9]

def load(raw):
    try:
        return json.loads(raw)
    except Exception:
        return {"parse_error": raw}

data = {
  "bom_line_id": bom_line_id,
  "substitute_item_id": sub_part_id,
  "substitute_id": sub_id,
  "add": load(add_raw),
  "list_before_remove": load(list_raw),
  "remove": load(remove_raw),
  "list_after_remove": load(list_after_raw),
}
with open(out, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

listed = (data["list_before_remove"].get("data") or {}).get("substitutes") or []
if not listed:
    raise SystemExit("substitutes list is empty after add")
removed_list = (data["list_after_remove"].get("data") or {}).get("substitutes") or []
if any((entry.get("id") == sub_id or entry.get("relationship", {}).get("id") == sub_id) for entry in removed_list):
    raise SystemExit("substitute still present after remove")
print("PLM substitutes mutation verification: OK")
PY

cat > "$report_md" <<REPORT_EOF
# Verification: PLM Substitutes Mutation - ${STAMP}

## Goal
Verify adding/removing BOM substitutes through federation mutation endpoints.

## Environment
- MetaSheet API: ${API_BASE}
- PLM Base URL: ${PLM_BASE_URL}
- Tenant/Org: ${PLM_TENANT_ID}/${PLM_ORG_ID}

## Data
- BOM line id: ${BOM_LINE_ID}
- Substitute part id: ${SUB_PART}
- Substitute relationship id: ${substitute_id}

## Results
- Add substitute: OK
- List substitutes (after add): non-empty
- Remove substitute: OK
- List substitutes (after remove): removed

## Artifacts
- JSON: ${report_json}
REPORT_EOF

echo "Report: ${report_md}"
