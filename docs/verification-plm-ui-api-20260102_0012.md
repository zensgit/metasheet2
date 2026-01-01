# PLM UI API verification (2026-01-02 00:12 CST)

## Scope
Verify PLM UI view endpoints used by `PlmProductView.vue` via federation API:
- Product detail
- BOM list
- Documents
- Approvals
- Where-used
- BOM compare
- Substitutes

## Environment
- Core backend: `http://127.0.0.1:7778`
- PLM base: `http://127.0.0.1:7910`
- Runtime env (core):
  - `PLM_API_MODE=yuantus`
  - `PLM_TENANT_ID=tenant-1`
  - `PLM_ORG_ID=org-1`
  - `PLM_USERNAME=admin`
  - `PLM_PASSWORD=admin`
  - `RBAC_BYPASS=true` (dev)

## Test IDs
- Product (parent): `0245efd6-9e98-4960-8f59-c232c842f2d2`
- Child: `9301a797-bdf0-46ee-a3c2-ae66e5880f68`
- BOM line: `ca787627-a93a-42cb-b11f-2760efb5f9b5`

## Commands
```bash
TOKEN=$(curl -s http://127.0.0.1:7778/api/auth/dev-token | jq -r .token)

# Product detail
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:7778/api/federation/plm/products/0245efd6-9e98-4960-8f59-c232c842f2d2?itemType=Part"

# BOM list
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:7778/api/federation/plm/products/0245efd6-9e98-4960-8f59-c232c842f2d2/bom"

# Documents
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"operation":"documents","productId":"0245efd6-9e98-4960-8f59-c232c842f2d2","pagination":{"limit":10,"offset":0}}' \
  http://127.0.0.1:7778/api/federation/plm/query

# Approvals
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"operation":"approvals","productId":"0245efd6-9e98-4960-8f59-c232c842f2d2","pagination":{"limit":10,"offset":0}}' \
  http://127.0.0.1:7778/api/federation/plm/query

# Where-used
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"operation":"where_used","itemId":"9301a797-bdf0-46ee-a3c2-ae66e5880f68","recursive":true,"maxLevels":5}' \
  http://127.0.0.1:7778/api/federation/plm/query

# BOM compare
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"operation":"bom_compare","leftId":"0245efd6-9e98-4960-8f59-c232c842f2d2","rightId":"0245efd6-9e98-4960-8f59-c232c842f2d2","leftType":"item","rightType":"item","maxLevels":2}' \
  http://127.0.0.1:7778/api/federation/plm/query

# Substitutes
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"operation":"substitutes","bomLineId":"ca787627-a93a-42cb-b11f-2760efb5f9b5"}' \
  http://127.0.0.1:7778/api/federation/plm/query
```

## Result
- HTTP status: all endpoints `200`
- BOM items: `1`
- Where-used count: `1`
- Documents: `1`
- Approvals: `0`
- Substitutes: `0`

## Notes
- The non-empty BOM comes from the test relationship created earlier; see `verification-plm-yuantus-bom-nonempty-20260101_2332.md`.
