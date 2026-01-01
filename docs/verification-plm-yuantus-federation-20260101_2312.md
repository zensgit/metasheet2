# PLM (Yuantus) federation query verification (2026-01-01 23:12 CST)

## Scope
- Core backend started with PLM auto-login (username/password)
- Federated query to Yuantus via `/api/federation/plm/query`

## Environment
- Core backend: `http://127.0.0.1:7778`
- PLM base: `http://127.0.0.1:7910`
- PLM auth: username/password (admin/admin)
- Runtime env used to start core:
  - `PLM_API_MODE=yuantus`
  - `PLM_TENANT_ID=tenant-1`
  - `PLM_ORG_ID=org-1`
  - `PLM_USERNAME=admin`
  - `PLM_PASSWORD=admin`
  - `DISABLE_WORKFLOW=true DISABLE_EVENT_BUS=true SKIP_PLUGINS=true RBAC_BYPASS=true`

## Commands
```bash
# Start core
PLM_BASE_URL=http://127.0.0.1:7910 \
PLM_API_MODE=yuantus \
PLM_TENANT_ID=tenant-1 \
PLM_ORG_ID=org-1 \
PLM_USERNAME=admin \
PLM_PASSWORD=admin \
DISABLE_WORKFLOW=true DISABLE_EVENT_BUS=true SKIP_PLUGINS=true RBAC_BYPASS=true JWT_SECRET=dev-secret-key PORT=7778 \
  pnpm --filter @metasheet/core-backend dev:core

# Dev token for local auth
TOKEN=$(curl -s http://127.0.0.1:7778/api/auth/dev-token | jq -r .token)

# Products
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"operation\":\"products\",\"pagination\":{\"limit\":1,\"offset\":0},\"filters\":{\"itemType\":\"Part\"}}" \
  http://127.0.0.1:7778/api/federation/plm/query

# BOM (root item from products)
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"operation\":\"bom\",\"productId\":\"0245efd6-9e98-4960-8f59-c232c842f2d2\"}" \
  http://127.0.0.1:7778/api/federation/plm/query
```

## Result
- Products: `200`
  - Sample item: `id=0245efd6-9e98-4960-8f59-c232c842f2d2`, `partNumber=J2824002-06-V2`
- BOM: `200`
  - Returned empty list for the sample item (no BOM lines on that Part).

## Notes
- Earlier 400 was caused by invalid JSON payload (shell quoting). Corrected request works.
- If you want BOM data to return non-empty, select an item with actual BOM lines and retry.
