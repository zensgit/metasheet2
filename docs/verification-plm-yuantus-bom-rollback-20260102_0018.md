# PLM (Yuantus) BOM rollback verification (2026-01-02 00:18 CST)

## Scope
Remove the test BOM relationship created for non-empty validation.

## Environment
- PLM base: `http://127.0.0.1:7910`
- Tenant: `tenant-1`
- Org: `org-1`
- Auth: `/api/v1/auth/login` (admin/admin)

## IDs
- Parent: `0245efd6-9e98-4960-8f59-c232c842f2d2`
- Child: `9301a797-bdf0-46ee-a3c2-ae66e5880f68`

## Commands
```bash
TOKEN=$(curl -s -H "Content-Type: application/json" \
  -H "x-tenant-id: tenant-1" -H "x-org-id: org-1" \
  -d '{"username":"admin","password":"admin","tenant_id":"tenant-1","org_id":"org-1"}' \
  http://127.0.0.1:7910/api/v1/auth/login | jq -r .access_token)

# Delete BOM relationship
curl -s -o /dev/null -w "delete:%{http_code}\\n" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-tenant-id: tenant-1" -H "x-org-id: org-1" \
  -X DELETE \
  "http://127.0.0.1:7910/api/v1/bom/0245efd6-9e98-4960-8f59-c232c842f2d2/children/9301a797-bdf0-46ee-a3c2-ae66e5880f68"

# Verify BOM is empty
curl -s -H "Authorization: Bearer $TOKEN" \
  -H "x-tenant-id: tenant-1" -H "x-org-id: org-1" \
  "http://127.0.0.1:7910/api/v1/bom/0245efd6-9e98-4960-8f59-c232c842f2d2/tree?depth=1" | \
  jq -r 'if (.children? | type == "array") then (.children | length) else -1 end'
```

## Result
- delete: `200`
- children count: `0`
