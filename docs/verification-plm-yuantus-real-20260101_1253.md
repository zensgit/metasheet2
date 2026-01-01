# PLM (Yuantus) real API verification (2026-01-01 12:53 CST)

## Scope
- Yuantus auth + health
- Search for Parts (used by `PLMAdapter` in yuantus mode)
- Item get via AML (used by `getProductById`)
- BOM tree lookup

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

# Login (token redacted)
curl -s -H "Content-Type: application/json" \
  -H "x-tenant-id: $TENANT" -H "x-org-id: $ORG" \
  -d '{"username":"admin","password":"admin","tenant_id":"tenant-1","org_id":"org-1"}' \
  $BASE/api/v1/auth/login

# Health
curl -s -o /dev/null -w "health:%{http_code}\\n" $BASE/api/v1/health

# Search (Parts)
TOKEN=<redacted>
curl -s -H "Authorization: Bearer $TOKEN" \
  -H "x-tenant-id: $TENANT" -H "x-org-id: $ORG" \
  "$BASE/api/v1/search/?q=&limit=5&item_type=Part" \
  | jq -r '{total: .total, first_id: .hits[0].id, first_item_number: .hits[0].item_number}'

# Item get (AML)
ITEM_ID=<first_id>
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
- Auth login: `200` (token issued)
- Health: `200`
- Search: `200`
  - Example payload: `total=455`, `first_id=aa67a635-533f-4a61-a116-3801dbde7028`, `first_item_number=P-VERIFY-1766071763`
- Item get (AML apply): `000` (curl timeout after 10s)
- BOM tree: `000` (curl timeout after 10s)

## Notes
- Earlier 401s were resolved by re-authenticating via `/api/v1/auth/login`.
- `item-get` and `bom-tree` time out; the endpoints may be slow or blocked. Consider:
  - Checking PLM server logs for request handling.
  - Verifying whether AML get expects additional payload fields or a different endpoint.
  - Testing BOM tree with smaller depth or a known lightweight BOM root.
