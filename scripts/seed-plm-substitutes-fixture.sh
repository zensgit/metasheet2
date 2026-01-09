#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

PLM_BASE_URL="${PLM_BASE_URL:-http://127.0.0.1:7910}"
PLM_TENANT_ID="${PLM_TENANT_ID:-tenant-1}"
PLM_ORG_ID="${PLM_ORG_ID:-org-1}"
PLM_USERNAME="${PLM_USERNAME:-admin}"
PLM_PASSWORD="${PLM_PASSWORD:-admin}"
OUTPUT_DIR="${OUTPUT_DIR:-artifacts}"
REPORT_DIR="${REPORT_DIR:-docs}"
FIXTURE_JSON="${FIXTURE_JSON:-$OUTPUT_DIR/plm-substitutes-fixture.json}"
STAMP="${STAMP:-$(date +%Y%m%d_%H%M%S)}"
REPORT_PATH="${REPORT_PATH:-$REPORT_DIR/verification-plm-substitutes-fixture-${STAMP}.md}"
PLM_SEED_ENV="${PLM_SEED_ENV:-}"
SEED_PREFIX_DEFAULT="MS-PLM-SUBS"
SEED_PREFIX="${SEED_PREFIX:-$SEED_PREFIX_DEFAULT}"
if [[ -n "$PLM_SEED_ENV" && "$SEED_PREFIX" == "$SEED_PREFIX_DEFAULT" ]]; then
  SEED_PREFIX="${SEED_PREFIX_DEFAULT}-${PLM_SEED_ENV}"
fi

PARENT_NUMBER="${PARENT_NUMBER:-${SEED_PREFIX}-PARENT}"
CHILD_NUMBER="${CHILD_NUMBER:-${SEED_PREFIX}-CHILD}"
SUB_NUMBER="${SUB_NUMBER:-${SEED_PREFIX}-SUB}"

mkdir -p "$OUTPUT_DIR" "$REPORT_DIR"

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

find_part_by_number() {
  local item_number="$1"
  curl -sS "$PLM_BASE_URL/api/v1/search/?q=${item_number}&limit=5&item_type=Part" "${HEADERS[@]}" \
    | python3 - <<'PY' "$item_number"
import json,sys
target = sys.argv[1]
try:
    data = json.load(sys.stdin)
except Exception:
    print("")
    raise SystemExit(0)
hits = data.get("hits") or []
for hit in hits:
    item_number = hit.get("item_number") or ""
    props = hit.get("properties") or {}
    if item_number == target or props.get("item_number") == target:
        print(hit.get("id") or "")
        raise SystemExit(0)
print("")
PY
}

create_part() {
  local item_number="$1"
  local name="$2"
  curl -sS -X POST "$PLM_BASE_URL/api/v1/aml/apply" "${HEADERS[@]}" \
    -H 'content-type: application/json' \
    -d "{\"type\":\"Part\",\"action\":\"add\",\"properties\":{\"item_number\":\"$item_number\",\"name\":\"$name\"}}" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))'
}

get_or_create_part() {
  local item_number="$1"
  local name="$2"
  local part_id
  part_id="$(find_part_by_number "$item_number")"
  if [[ -z "$part_id" ]]; then
    part_id="$(create_part "$item_number" "$name")"
  fi
  if [[ -z "$part_id" ]]; then
    part_id="$(find_part_by_number "$item_number")"
  fi
  echo "$part_id"
}

add_child() {
  local parent_id="$1"
  local child_id="$2"
  curl -sS -X POST "$PLM_BASE_URL/api/v1/bom/$parent_id/children" "${HEADERS[@]}" \
    -H 'content-type: application/json' \
    -d "{\"child_id\":\"$child_id\",\"quantity\":1,\"uom\":\"EA\"}" >/dev/null
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

ensure_bom_line() {
  local parent_id="$1"
  local child_id="$2"
  local line_id
  line_id="$(get_bom_line_id "$parent_id" "$child_id")"
  if [[ -z "$line_id" ]]; then
    add_child "$parent_id" "$child_id"
    line_id="$(get_bom_line_id "$parent_id" "$child_id")"
  fi
  echo "$line_id"
}

find_substitute_rel() {
  local bom_line_id="$1"
  local sub_part_id="$2"
  local response
  response=$(curl -sS "$PLM_BASE_URL/api/v1/bom/$bom_line_id/substitutes" "${HEADERS[@]}" || true)
  python3 - <<'PY' "$sub_part_id" "$response"
import json,sys
target = sys.argv[1]
raw = sys.argv[2]
try:
    data = json.loads(raw)
except Exception:
    print("")
    raise SystemExit(0)
subs = data.get("substitutes") or []
for entry in subs:
    part = entry.get("substitute_part") or {}
    if part.get("id") == target:
        rel_id = entry.get("id") or (entry.get("relationship") or {}).get("id") or ""
        print(rel_id)
        raise SystemExit(0)
print("")
PY
}

add_substitute() {
  local bom_line_id="$1"
  local sub_part_id="$2"
  curl -sS -X POST "$PLM_BASE_URL/api/v1/bom/$bom_line_id/substitutes" "${HEADERS[@]}" \
    -H 'content-type: application/json' \
    -d "{\"substitute_item_id\":\"$sub_part_id\",\"properties\":{\"rank\":1,\"note\":\"seed\"}}" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("substitute_id",""))'
}

PARENT_ID="$(get_or_create_part "$PARENT_NUMBER" "PLM Seed Parent")"
CHILD_ID="$(get_or_create_part "$CHILD_NUMBER" "PLM Seed Child")"
SUB_ID="$(get_or_create_part "$SUB_NUMBER" "PLM Seed Substitute")"

if [[ -z "$PARENT_ID" || -z "$CHILD_ID" || -z "$SUB_ID" ]]; then
  echo "Failed to resolve seed part IDs." >&2
  exit 1
fi

BOM_LINE_ID="$(ensure_bom_line "$PARENT_ID" "$CHILD_ID")"
if [[ -z "$BOM_LINE_ID" ]]; then
  echo "Failed to resolve BOM line id." >&2
  exit 1
fi

SUB_REL_ID="$(find_substitute_rel "$BOM_LINE_ID" "$SUB_ID")"
if [[ -z "$SUB_REL_ID" ]]; then
  SUB_REL_ID="$(add_substitute "$BOM_LINE_ID" "$SUB_ID")"
fi
if [[ -z "$SUB_REL_ID" ]]; then
  SUB_REL_ID="$(find_substitute_rel "$BOM_LINE_ID" "$SUB_ID")"
fi
if [[ -z "$SUB_REL_ID" ]]; then
  echo "Failed to resolve substitute relationship id." >&2
  exit 1
fi

python3 - <<'PY' "$FIXTURE_JSON" "$PLM_BASE_URL" "$PLM_TENANT_ID" "$PLM_ORG_ID" "$PARENT_ID" "$PARENT_NUMBER" "$CHILD_ID" "$SUB_ID" "$BOM_LINE_ID" "$SUB_REL_ID"
import json
import sys
from datetime import datetime, timezone

out, plm_base, tenant_id, org_id, parent_id, parent_num, child_id, sub_id, bom_line_id, sub_rel_id = sys.argv[1:11]

payload = {
  "plm_base_url": plm_base,
  "tenant_id": tenant_id,
  "org_id": org_id,
  "product_id": parent_id,
  "product_item_number": parent_num,
  "search_query": parent_num,
  "child_id": child_id,
  "substitute_item_id": sub_id,
  "bom_line_id": bom_line_id,
  "substitute_id": sub_rel_id,
  "created_at": datetime.now(timezone.utc).isoformat(),
}

with open(out, "w", encoding="utf-8") as f:
  json.dump(payload, f, ensure_ascii=False, indent=2)
PY

cat > "$REPORT_PATH" <<REPORT_EOF
# Verification: PLM Substitutes Fixture Seed - ${STAMP}

## Goal
Create stable PLM fixture data for UI substitutes regression.

## Environment
- PLM Base URL: ${PLM_BASE_URL}
- Tenant/Org: ${PLM_TENANT_ID}/${PLM_ORG_ID}

## Seed Data
- Product ID: ${PARENT_ID}
- Product Item Number: ${PARENT_NUMBER}
- Child ID: ${CHILD_ID}
- BOM Line ID: ${BOM_LINE_ID}
- Substitute Item ID: ${SUB_ID}
- Substitute Relationship ID: ${SUB_REL_ID}

## Artifact
- Fixture JSON: ${FIXTURE_JSON}

Status: PASS
REPORT_EOF

echo "Fixture: ${FIXTURE_JSON}"
echo "Report: ${REPORT_PATH}"
