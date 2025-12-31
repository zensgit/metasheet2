# Yuantus PLM connection notes

## Base URL
- Default: `http://127.0.0.1:7910`

## Authentication
- Login: `POST /api/v1/auth/login`
- Body (JSON):
  ```json
  {
    "username": "admin",
    "password": "admin",
    "tenant_id": "tenant-1",
    "org_id": "org-1"
  }
  ```
- Response: `{ "access_token": "...", "expires_in": 3600 }`

## Required headers
- `Authorization: Bearer <access_token>`
- `x-tenant-id: tenant-1`
- `x-org-id: org-1`

## Core endpoints used by MetaSheet
- Health: `GET /api/v1/health`
- AML get/add: `POST /api/v1/aml/apply`
- Search: `GET /api/v1/search/?q=<keyword>&item_type=Part`
- BOM tree: `GET /api/v1/bom/{parent_id}/tree?depth=2`
- Where-used: `GET /api/v1/bom/{item_id}/where-used?recursive=true&max_levels=5`
- BOM compare: `GET /api/v1/bom/compare?left_type=item&left_id=...&right_type=item&right_id=...&max_levels=10`
- Substitutes: `GET /api/v1/bom/{bom_line_id}/substitutes`

## MetaSheet backend env wiring
The PLM adapter reads from config service or these env vars:
- `PLM_BASE_URL` (or `PLM_URL`)
- `PLM_API_TOKEN` (or `PLM_AUTH_TOKEN` / `PLM_TOKEN`)
- `PLM_TENANT_ID`
- `PLM_ORG_ID`
- `PLM_USERNAME` / `PLM_PASSWORD` (optional: token auto-refresh)
- `PLM_ITEM_TYPE` (default: `Part`)

Example (dev):
```bash
PLM_BASE_URL=http://127.0.0.1:7910 \
PLM_TENANT_ID=tenant-1 \
PLM_ORG_ID=org-1 \
PLM_USERNAME=admin \
PLM_PASSWORD=admin \
PLM_ITEM_TYPE=Part \
RBAC_BYPASS=true \
JWT_SECRET=dev-secret-key \
pnpm --filter @metasheet/core-backend dev:core
```

## Notes
- Yuantus BOM compare requires `left_type/right_type` and `left_id/right_id` query params.
- Substitutes API expects BOM relationship IDs (not child item IDs).
