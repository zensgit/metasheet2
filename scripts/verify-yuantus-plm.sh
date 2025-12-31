#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${PLM_BASE_URL:-http://127.0.0.1:7910}"
TENANT_ID="${PLM_TENANT_ID:-tenant-1}"
ORG_ID="${PLM_ORG_ID:-org-1}"
USERNAME="${PLM_USERNAME:-admin}"
PASSWORD="${PLM_PASSWORD:-admin}"
ITEM_ID="${PLM_ITEM_ID:-}"
BOM_ITEM_ID="${PLM_BOM_ITEM_ID:-}"
ITEM_TYPE="${PLM_ITEM_TYPE:-Part}"
WHERE_USED_ITEM_ID="${PLM_WHERE_USED_ITEM_ID:-}"
BOM_COMPARE_LEFT_ID="${PLM_BOM_COMPARE_LEFT_ID:-}"
BOM_COMPARE_RIGHT_ID="${PLM_BOM_COMPARE_RIGHT_ID:-}"
BOM_LINE_ID="${PLM_BOM_LINE_ID:-}"
BOM_DEPTH="${PLM_BOM_DEPTH:-2}"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'EOF'
Usage:
  PLM_ITEM_ID=<item-id> PLM_BOM_ITEM_ID=<bom-root-id> bash scripts/verify-yuantus-plm.sh

Env vars (optional):
  PLM_BASE_URL   (default: http://127.0.0.1:7910)
  PLM_TENANT_ID  (default: tenant-1)
  PLM_ORG_ID     (default: org-1)
  PLM_USERNAME   (default: admin)
  PLM_PASSWORD   (default: admin)
  PLM_ITEM_TYPE  (default: Part)
  PLM_BOM_DEPTH  (default: 2)
  PLM_WHERE_USED_ITEM_ID  (optional)
  PLM_BOM_COMPARE_LEFT_ID (optional)
  PLM_BOM_COMPARE_RIGHT_ID (optional)
  PLM_BOM_LINE_ID (optional, auto-detected from BOM tree if omitted)
EOF
  exit 0
fi

if [[ -z "$ITEM_ID" ]]; then
  echo "PLM_ITEM_ID is required (example: de7471da-0a5c-4436-971c-65ed64418df0)"
  exit 1
fi

if [[ -z "$BOM_ITEM_ID" ]]; then
  echo "PLM_BOM_ITEM_ID is required (example: fc5ff0f7-3dc2-42ac-b95f-347fcbe476f1)"
  exit 1
fi

TOKEN=$(curl -sS -X POST "$BASE_URL/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-org-id: $ORG_ID" \
  -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\",\"tenant_id\":\"$TENANT_ID\",\"org_id\":\"$ORG_ID\"}" \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('access_token',''))")

if [[ -z "$TOKEN" ]]; then
  echo "Failed to obtain PLM token"
  exit 1
fi

echo "Token OK (len=${#TOKEN})"

echo "== Health =="
curl -sS "$BASE_URL/api/v1/health" | python3 -c "import json,sys; print(json.load(sys.stdin))"

echo "== Search (GET) =="
curl -sS "$BASE_URL/api/v1/search/?q=&limit=2&item_type=$ITEM_TYPE" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-org-id: $ORG_ID" \
  | python3 -c "import json,sys; data=json.load(sys.stdin); print('keys:', list(data.keys())); print('total:', data.get('total')); print('hits_len:', len(data.get('hits') or []))"

echo "== AML Apply (get item) =="
curl -sS -X POST "$BASE_URL/api/v1/aml/apply" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-org-id: $ORG_ID" \
  -d "{\"type\":\"$ITEM_TYPE\",\"action\":\"get\",\"id\":\"$ITEM_ID\"}" \
  | python3 -c "import json,sys; data=json.load(sys.stdin); items=data.get('items') or []; first=items[0] if items else None; print('items_len:', len(items)); print('item_keys:', sorted(first.keys()) if isinstance(first, dict) else first)"

echo "== BOM Tree =="
BOM_TREE_JSON=$(curl -sS "$BASE_URL/api/v1/bom/$BOM_ITEM_ID/tree?depth=$BOM_DEPTH" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-org-id: $ORG_ID")

echo "$BOM_TREE_JSON" | python3 -c "import json,sys; data=json.load(sys.stdin); children=data.get('children') if isinstance(data, dict) else None; print('root_keys:', list(data.keys()) if isinstance(data, dict) else 'n/a'); print('children_len:', len(children) if isinstance(children, list) else None)"

if [[ -z "$BOM_LINE_ID" ]]; then
  BOM_LINE_ID=$(python3 -c $'import json,sys\npayload=json.load(sys.stdin)\nids=[]\nstack=[payload]\nwhile stack:\n    node=stack.pop()\n    if isinstance(node, dict):\n        rel=node.get(\"relationship\")\n        if isinstance(rel, dict):\n            rel_id=rel.get(\"id\") or rel.get(\"relationship_id\") or rel.get(\"line_id\")\n            if isinstance(rel_id, str):\n                ids.append(rel_id)\n        stack.extend(node.values())\n    elif isinstance(node, list):\n        stack.extend(node)\nprint(ids[0] if ids else \"\")' <<< "$BOM_TREE_JSON")

  if [[ -n "$BOM_LINE_ID" ]]; then
    echo "Auto-detected BOM line id: $BOM_LINE_ID"
  else
    echo "No BOM line id detected from BOM tree"
  fi
fi

if [[ -n "$WHERE_USED_ITEM_ID" ]]; then
  echo "== Where Used =="
  curl -sS "$BASE_URL/api/v1/bom/$WHERE_USED_ITEM_ID/where-used?recursive=true&max_levels=5" \
    -H "Authorization: Bearer $TOKEN" \
    -H "x-tenant-id: $TENANT_ID" \
    -H "x-org-id: $ORG_ID" \
    | python3 -c "import json,sys; data=json.load(sys.stdin); print('item_id:', data.get('item_id')); print('count:', data.get('count')); print('parents_len:', len(data.get('parents') or []))"
else
  echo "== Where Used == (skipped)"
fi

if [[ -n "$BOM_COMPARE_LEFT_ID" && -n "$BOM_COMPARE_RIGHT_ID" ]]; then
  echo "== BOM Compare =="
  curl -sS "$BASE_URL/api/v1/bom/compare?left_id=$BOM_COMPARE_LEFT_ID&right_id=$BOM_COMPARE_RIGHT_ID&left_type=item&right_type=item&max_levels=10" \
    -H "Authorization: Bearer $TOKEN" \
    -H "x-tenant-id: $TENANT_ID" \
    -H "x-org-id: $ORG_ID" \
    | python3 -c "import json,sys; data=json.load(sys.stdin); summary=data.get('summary') or {}; print('summary:', summary)"
else
  echo "== BOM Compare == (skipped)"
fi

if [[ -n "$BOM_LINE_ID" ]]; then
  echo "== BOM Substitutes =="
  curl -sS "$BASE_URL/api/v1/bom/$BOM_LINE_ID/substitutes" \
    -H "Authorization: Bearer $TOKEN" \
    -H "x-tenant-id: $TENANT_ID" \
    -H "x-org-id: $ORG_ID" \
    | python3 -c "import json,sys; data=json.load(sys.stdin); print('bom_line_id:', data.get('bom_line_id')); print('count:', data.get('count')); print('subs_len:', len(data.get('substitutes') or []))"
else
  echo "== BOM Substitutes == (skipped)"
fi

echo "== Done =="
