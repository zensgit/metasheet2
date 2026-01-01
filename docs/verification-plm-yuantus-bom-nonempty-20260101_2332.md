# PLM (Yuantus) BOM non-empty verification (2026-01-01 23:32 CST)

## Scope
- Create a BOM relationship via PLM API
- Verify BOM tree returns children
- Verify MetaSheet federation query returns BOM items

## Environment
- PLM base: `http://127.0.0.1:7910`
- Tenant: `tenant-1`
- Org: `org-1`
- Auth: `/api/v1/auth/login` (admin/admin)
- Core backend: `http://127.0.0.1:7778` (auto-login with PLM_USERNAME/PLM_PASSWORD)

## Commands
```bash
# 1) Create BOM line
TOKEN=$(curl -s -H "Content-Type: application/json" \
  -H "x-tenant-id: tenant-1" -H "x-org-id: org-1" \
  -d '{"username":"admin","password":"admin","tenant_id":"tenant-1","org_id":"org-1"}' \
  http://127.0.0.1:7910/api/v1/auth/login | jq -r .access_token)

HITS=$(curl -s -H "Authorization: Bearer $TOKEN" \
  -H "x-tenant-id: tenant-1" -H "x-org-id: org-1" \
  "http://127.0.0.1:7910/api/v1/search/?q=&limit=2&item_type=Part")

PARENT_ID=$(echo "$HITS" | jq -r '.hits[0].id')
CHILD_ID=$(echo "$HITS" | jq -r '.hits[1].id')

curl -s -H "Authorization: Bearer $TOKEN" \
  -H "x-tenant-id: tenant-1" -H "x-org-id: org-1" \
  -H "Content-Type: application/json" \
  -d "{\"child_id\":\"$CHILD_ID\",\"quantity\":1,\"uom\":\"EA\",\"find_num\":\"1\"}" \
  "http://127.0.0.1:7910/api/v1/bom/$PARENT_ID/children"

# 2) Verify BOM tree
curl -s -H "Authorization: Bearer $TOKEN" \
  -H "x-tenant-id: tenant-1" -H "x-org-id: org-1" \
  "http://127.0.0.1:7910/api/v1/bom/$PARENT_ID/tree?depth=1"

# 3) Federation query (MetaSheet core)
TOKEN_CORE=$(curl -s http://127.0.0.1:7778/api/auth/dev-token | jq -r .token)

curl -s -H "Authorization: Bearer $TOKEN_CORE" -H "Content-Type: application/json" \
  -d "{\"operation\":\"bom\",\"productId\":\"$PARENT_ID\"}" \
  http://127.0.0.1:7778/api/federation/plm/query
```

## Result
- BOM relationship created:
  - `parent_id=0245efd6-9e98-4960-8f59-c232c842f2d2`
  - `child_id=9301a797-bdf0-46ee-a3c2-ae66e5880f68`
  - `relationship_id=ca787627-a93a-42cb-b11f-2760efb5f9b5`
- BOM tree children count: `1`
- Federation BOM query: `200` with non-empty items

## Notes
- This creates a new BOM line in the dev dataset to ensure non-empty verification.
