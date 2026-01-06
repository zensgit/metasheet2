# PLM product detail mapping verification

Date: 2026-01-06

## Summary
- Added Yuantus-aware PLM adapter with product detail merge logic (AML detail + search timestamps).
- Added federation PLM endpoints for products, BOM, documents, and approvals.
- Added unit coverage for Yuantus product detail, documents, and approvals mappings.

## Environment
- Node/Pnpm: pnpm 10.x
- Backend: `packages/core-backend`
- PLM config (for manual API checks):
  - `PLM_BASE_URL=http://127.0.0.1:7910`
  - `PLM_API_MODE=yuantus`
  - `PLM_TENANT_ID=tenant-1`
  - `PLM_ORG_ID=org-1`
  - `PLM_USERNAME=admin`
  - `PLM_PASSWORD=admin`

## Automated tests
```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-adapter-yuantus.test.ts --reporter=dot
```

Result: **passed** (4 tests).

Warnings observed (existing):
- Duplicate `@wendellhu/redi` key in `packages/core-backend/package.json`.
- Vite CJS Node API deprecation notice.

## Manual API checks (optional)
```bash
curl -s "http://127.0.0.1:7778/api/federation/plm/products?itemType=Part&limit=5"
curl -s "http://127.0.0.1:7778/api/federation/plm/products/<item_id>?itemType=Part"
curl -s "http://127.0.0.1:7778/api/federation/plm/products/<item_id>/bom"
curl -s -X POST "http://127.0.0.1:7778/api/federation/plm/query" \
  -H "content-type: application/json" \
  -d '{"operation":"documents","productId":"<item_id>","limit":5}'
curl -s -X POST "http://127.0.0.1:7778/api/federation/plm/query" \
  -H "content-type: application/json" \
  -d '{"operation":"approvals","status":"approved","limit":5}'
```

Expected:
- `products` returns list + `total`.
- `product` returns mapped fields with `created_at`/`updated_at` merged from search hit when AML detail lacks timestamps.
- `bom` returns array (empty allowed).
- `documents` returns mapped file metadata with preview/download URLs.
- `approvals` returns mapped ECO approvals with normalized status.
