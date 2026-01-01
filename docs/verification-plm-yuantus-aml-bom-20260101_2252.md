# PLM (Yuantus) AML + BOM verification (2026-01-01 22:52 CST)

## Scope
- Resolve AML apply + BOM tree timeouts
- Confirm valid item ID flow from search

## Environment
- Base URL: `http://127.0.0.1:7910`
- Tenant: `tenant-1`
- Org: `org-1`
- Auth: `/api/v1/auth/login` (token redacted)

## Commands
```bash
BASE=http://127.0.0.1:7910
TENANT=tenant-1
ORG=org-1
TOKEN=$(curl -s -H "Content-Type: application/json" \
  -H "x-tenant-id: $TENANT" -H "x-org-id: $ORG" \
  -d '{"username":"admin","password":"admin","tenant_id":"tenant-1","org_id":"org-1"}' \
  $BASE/api/v1/auth/login | jq -r .access_token)

# Search (use first Part hit)
HIT=$(curl -s -H "Authorization: Bearer $TOKEN" \
  -H "x-tenant-id: $TENANT" -H "x-org-id: $ORG" \
  "$BASE/api/v1/search/?q=&limit=1&item_type=Part")

ITEM_ID=$(echo "$HIT" | jq -r '.hits[0].id')
CONFIG_ID=$(echo "$HIT" | jq -r '.hits[0].config_id')

# AML apply
curl --max-time 10 -s -o /dev/null -w "item-get:%{http_code}\\n" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-tenant-id: $TENANT" -H "x-org-id: $ORG" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"Part\",\"action\":\"get\",\"id\":\"$ITEM_ID\"}" \
  $BASE/api/v1/aml/apply

# BOM tree
curl --max-time 10 -s -o /dev/null -w "bom-tree:%{http_code}\\n" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-tenant-id: $TENANT" -H "x-org-id: $ORG" \
  "$BASE/api/v1/bom/$ITEM_ID/tree?depth=2"
```

## Result
- Search hit:
  - `id=0245efd6-9e98-4960-8f59-c232c842f2d2`
  - `config_id=1f0a5f84-6c39-4577-a8ad-562f682ee047`
- AML apply: `200`
- BOM tree: `200`

## Notes
- The earlier timeouts were resolved by using a fresh token from the same host and a valid `id` from search results.
- If timeouts recur, verify token signature (`Invalid signature` indicates a mismatched token/secret) and avoid stale tokens.
