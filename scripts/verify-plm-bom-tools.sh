#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

API_BASE="${API_BASE:-http://127.0.0.1:7778}"
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
OUTPUT_DIR="${OUTPUT_DIR:-artifacts}"
OUTPUT_BASENAME="${OUTPUT_BASENAME:-plm-bom-tools}"
STAMP="${STAMP:-$(date +%Y%m%d_%H%M)}"

port_open() {
  python3 - <<'PY' "$1" "$2" >/dev/null 2>&1
import socket
import sys

host = sys.argv[1]
port = int(sys.argv[2])
sock = socket.socket()
sock.settimeout(0.5)
try:
    sock.connect((host, port))
except Exception:
    raise SystemExit(1)
finally:
    sock.close()
PY
}

ensure_smoke_db() {
  if [[ "$AUTO_START" != "true" ]]; then
    return 0
  fi

  local host port
  mapfile -t db_parts < <(python3 - <<'PY' "$SMOKE_DATABASE_URL"
from urllib.parse import urlparse
import sys

url = sys.argv[1]
parsed = urlparse(url)
print(parsed.hostname or "")
print(parsed.port or "")
PY
  )
  host="${db_parts[0]:-}"
  port="${db_parts[1]:-}"

  if [[ -z "$host" || -z "$port" ]]; then
    return 0
  fi
  if [[ "$host" != "127.0.0.1" && "$host" != "localhost" ]]; then
    return 0
  fi
  if port_open "$host" "$port"; then
    return 0
  fi
  if ! command -v docker >/dev/null 2>&1; then
    echo "Dev postgres not reachable and docker is not available." >&2
    return 1
  fi
  if [[ ! -f "$ROOT_DIR/docker/dev-postgres.yml" ]]; then
    echo "Missing docker/dev-postgres.yml; cannot auto-start dev database." >&2
    return 1
  fi

  echo "Starting dev postgres (docker/dev-postgres.yml)..."
  (cd "$ROOT_DIR" && docker compose -f docker/dev-postgres.yml up -d)
  for _ in {1..30}; do
    if port_open "$host" "$port"; then
      return 0
    fi
    sleep 1
  done

  echo "Dev postgres still not reachable on ${host}:${port}." >&2
  return 1
}

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

  ensure_smoke_db

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
  METASHEET_TOKEN=$(curl -sS "${API_BASE}/api/auth/dev-token?roles=admin&perms=federation:read,federation:write" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' || true)
fi

if [[ -z "$METASHEET_TOKEN" ]]; then
  token_json="$OUTPUT_DIR/${OUTPUT_BASENAME}-token.json"
  token_err="$OUTPUT_DIR/${OUTPUT_BASENAME}-token.err"
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

PLM_TOKEN=$(curl -sS -X POST "$PLM_BASE_URL/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: $PLM_TENANT_ID" \
  -H "x-org-id: $PLM_ORG_ID" \
  -d "{\"username\":\"$PLM_USERNAME\",\"password\":\"$PLM_PASSWORD\",\"tenant_id\":\"$PLM_TENANT_ID\",\"org_id\":\"$PLM_ORG_ID\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access_token",""))' || true)

if [[ -z "$PLM_TOKEN" ]]; then
  echo "PLM token not available; continuing without Authorization header." >&2
  HEADERS=(-H "x-tenant-id: $PLM_TENANT_ID" -H "x-org-id: $PLM_ORG_ID")
else
  HEADERS=(-H "x-tenant-id: $PLM_TENANT_ID" -H "x-org-id: $PLM_ORG_ID" -H "Authorization: Bearer $PLM_TOKEN")
fi

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
PARENT_A_NUMBER="UI-CMP-A-$TS"
PARENT_B_NUMBER="UI-CMP-B-$TS"
CHILD_X_NUMBER="UI-CMP-X-$TS"
CHILD_Y_NUMBER="UI-CMP-Y-$TS"
CHILD_Z_NUMBER="UI-CMP-Z-$TS"
SUB_PART_NUMBER="UI-CMP-S-$TS"
CHILD_X_FIND_NUM_A="010"
CHILD_X_REFDES_A="R0"
CHILD_X_FIND_NUM_B="020"
CHILD_X_REFDES_B="R1,R2"

PARENT_A=$(create_part "$PARENT_A_NUMBER" "UI Compare A")
PARENT_B=$(create_part "$PARENT_B_NUMBER" "UI Compare B")
CHILD_X=$(create_part "$CHILD_X_NUMBER" "UI Child X")
CHILD_Y=$(create_part "$CHILD_Y_NUMBER" "UI Child Y")
CHILD_Z=$(create_part "$CHILD_Z_NUMBER" "UI Child Z")
SUB_PART=$(create_part "$SUB_PART_NUMBER" "UI Substitute")

if [[ -z "$PARENT_A" || -z "$PARENT_B" || -z "$CHILD_X" || -z "$CHILD_Y" || -z "$CHILD_Z" || -z "$SUB_PART" ]]; then
  echo "Failed to create sample items in PLM." >&2
  exit 1
fi

add_child "$PARENT_A" "$CHILD_X" "{\"child_id\":\"$CHILD_X\",\"quantity\":1,\"uom\":\"EA\",\"find_num\":\"$CHILD_X_FIND_NUM_A\",\"refdes\":\"$CHILD_X_REFDES_A\"}" >/dev/null
add_child "$PARENT_A" "$CHILD_Y" "{\"child_id\":\"$CHILD_Y\",\"quantity\":1,\"uom\":\"EA\"}" >/dev/null

add_child "$PARENT_B" "$CHILD_X" "{\"child_id\":\"$CHILD_X\",\"quantity\":2,\"uom\":\"EA\",\"find_num\":\"$CHILD_X_FIND_NUM_B\",\"refdes\":\"$CHILD_X_REFDES_B\"}" >/dev/null
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

DOC_ROLE="drawing"
DOC_VERSION="A"
DOC_FILENAME="UI-DOC-$TS.txt"
DOC_PATH="$OUTPUT_DIR/$DOC_FILENAME"
printf "UI document %s\n" "$TS" > "$DOC_PATH"

DOC_UPLOAD=$(curl -sS -X POST "$PLM_BASE_URL/api/v1/file/upload" "${HEADERS[@]}" \
  -F "file=@${DOC_PATH};filename=${DOC_FILENAME}" \
  -F "author=metasheet-ui" \
  -F "source_system=metasheet" \
  -F "source_version=ui-regression" \
  -F "document_version=${DOC_VERSION}")
DOC_FILE_ID=$(echo "$DOC_UPLOAD" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))')
if [[ -z "$DOC_FILE_ID" ]]; then
  echo "Failed to upload document: $DOC_UPLOAD" >&2
  exit 1
fi

ATTACH_RESP=$(curl -sS -X POST "$PLM_BASE_URL/api/v1/file/attach" "${HEADERS[@]}" \
  -H 'content-type: application/json' \
  -d "{\"item_id\":\"$PARENT_A\",\"file_id\":\"$DOC_FILE_ID\",\"file_role\":\"$DOC_ROLE\",\"description\":\"UI regression document\"}")
DOC_ATTACHMENT_ID=$(echo "$ATTACH_RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))')
if [[ -z "$DOC_ATTACHMENT_ID" ]]; then
  echo "Failed to attach document: $ATTACH_RESP" >&2
  exit 1
fi

rm -f "$DOC_PATH"

ECO_NAME="UI ECO $TS"
ECO_RESP=$(curl -sS -X POST "$PLM_BASE_URL/api/v1/eco" "${HEADERS[@]}" \
  -H 'content-type: application/json' \
  -d "{\"name\":\"$ECO_NAME\",\"eco_type\":\"bom\",\"product_id\":\"$PARENT_A\",\"description\":\"UI approval test\",\"priority\":\"normal\"}")
ECO_ID=$(echo "$ECO_RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))')
ECO_STATE=$(echo "$ECO_RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("state",""))')
if [[ -z "$ECO_ID" ]]; then
  echo "Failed to create ECO: $ECO_RESP" >&2
  exit 1
fi

REINDEX_RESP=$(curl -sS -X POST "$PLM_BASE_URL/api/v1/search/reindex" "${HEADERS[@]}" \
  -H 'content-type: application/json' \
  -d '{"item_type_id":"Part","reset":false,"limit":200,"batch_size":200}')
REINDEX_OK=$(echo "$REINDEX_RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("ok", False))')
if [[ "$REINDEX_OK" != "True" && "$REINDEX_OK" != "true" ]]; then
  echo "Failed to reindex search: $REINDEX_RESP" >&2
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

python3 - <<'PY' "$resp_where" "$resp_compare" "$resp_subs" "$report_json" "$DOC_FILE_ID" "$DOC_FILENAME" "$DOC_ROLE" "$DOC_VERSION" "$DOC_ATTACHMENT_ID" "$ECO_ID" "$ECO_NAME" "$ECO_STATE" "$PARENT_A" "$PARENT_A_NUMBER" "$PARENT_B" "$CHILD_X" "$CHILD_Y" "$CHILD_Z" "$SUB_PART" "$BOM_LINE_X" "$SUB_REL_ID" "$CHILD_X_FIND_NUM_A" "$CHILD_X_REFDES_A"
import json,sys
where_raw, compare_raw, subs_raw, out = sys.argv[1:5]
doc_file_id, doc_filename, doc_role, doc_version, doc_attachment_id = sys.argv[5:10]
eco_id, eco_name, eco_state, product_id, product_number = sys.argv[10:15]
parent_b, child_x, child_y, child_z, sub_part, bom_line, sub_rel_id = sys.argv[15:22]
child_x_find_num, child_x_refdes = sys.argv[22:24]
def load(raw):
    try:
        return json.loads(raw)
    except Exception:
        return {"parse_error": raw}
data = {
  "where_used": load(where_raw),
  "bom_compare": load(compare_raw),
  "substitutes": load(subs_raw),
  "bom": {
    "parent_id": product_id,
    "child_id": child_x,
    "find_num": child_x_find_num,
    "refdes": child_x_refdes,
  },
  "documents": {
    "item_id": product_id,
    "file_id": doc_file_id,
    "filename": doc_filename,
    "file_role": doc_role,
    "document_version": doc_version,
    "attachment_id": doc_attachment_id,
  },
  "approvals": {
    "eco_id": eco_id,
    "eco_name": eco_name,
    "eco_state": eco_state,
    "product_id": product_id,
    "product_number": product_number,
  },
  "fixtures": {
    "parent_a": product_id,
    "parent_b": parent_b,
    "child_x": child_x,
    "child_y": child_y,
    "child_z": child_z,
    "bom_child_id": child_x,
    "bom_child_find_num": child_x_find_num,
    "bom_child_refdes": child_x_refdes,
    "substitute": sub_part,
    "bom_line_id": bom_line,
    "substitute_rel_id": sub_rel_id,
    "doc_file_id": doc_file_id,
    "doc_attachment_id": doc_attachment_id,
    "eco_id": eco_id,
  },
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

python3 - <<'PY' "$report_json" "$report_md" "$API_BASE" "$PLM_BASE_URL" "$PARENT_A" "$PARENT_B" "$CHILD_X" "$CHILD_Y" "$CHILD_Z" "$SUB_PART" "$BOM_LINE_X" "$DOC_FILE_ID" "$DOC_FILENAME" "$DOC_ROLE" "$DOC_VERSION" "$DOC_ATTACHMENT_ID" "$ECO_ID" "$ECO_NAME" "$ECO_STATE" "$PARENT_A_NUMBER"
import json,sys
report_json, report_md, api_base, plm_base = sys.argv[1:5]
parent_a, parent_b, child_x, child_y, child_z, sub_part, bom_line = sys.argv[5:12]
doc_file_id, doc_filename, doc_role, doc_version, doc_attachment_id, eco_id, eco_name, eco_state, parent_a_number = sys.argv[12:21]

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
    f"- BOM Child ID: {child_x}",
    f"- Substitute Part: {sub_part}",
    f"- BOM Line ID (Child X): {bom_line}",
    f"- Parent A Number: {parent_a_number}",
    f"- Document File ID: {doc_file_id}",
    f"- Document Name: {doc_filename}",
    f"- Document Role: {doc_role}",
    f"- Document Version: {doc_version}",
    f"- Document Attachment ID: {doc_attachment_id}",
    f"- ECO ID: {eco_id}",
    f"- ECO Name: {eco_name}",
    f"- ECO State: {eco_state}",
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
