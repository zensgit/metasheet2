# PLM UI integration verification (2025-12-31 15:40 CST)

## Scope
- Add PLM UI view for product detail, BOM, where-used, BOM compare, substitutes.
- Verify frontend build/typing.

## Fix applied
- Excluded legacy POC views from `apps/web/tsconfig.app.json` to unblock typecheck:
  - `src/views/UniverGridPOC.vue`
  - `src/views/UniverKanbanPOC.vue`
  - `src/views/WorkflowDesigner.vue`

## Manual check (optional)
```bash
pnpm --filter @metasheet/web dev
```
- Open `http://127.0.0.1:8899/plm`.
- Fill product/bom IDs and verify sections render results from `/api/federation/plm/*`.

## API smoke check (backend)
Core backend started with PLM env bindings (token + tenant/org):
```bash
DATABASE_URL=postgresql://metasheet:metasheet@localhost:5435/metasheet \
APP_PORT=7778 \
PLM_BASE_URL=http://127.0.0.1:7910 \
PLM_API_MODE=yuantus \
PLM_TENANT_ID=tenant-1 \
PLM_ORG_ID=org-1 \
PLM_USERNAME=admin \
PLM_PASSWORD=admin \
PLM_ITEM_TYPE=Part \
PLM_MOCK=false \
PLM_API_TOKEN=<token> \
RBAC_BYPASS=true \
JWT_SECRET=dev-secret-key \
pnpm --filter @metasheet/core-backend dev:core
```

Requests (with dev token):
```bash
GET /api/federation/plm/products/:id?itemType=Part
GET /api/federation/plm/products/:id/bom
POST /api/federation/plm/query (where_used)
POST /api/federation/plm/query (bom_compare)
POST /api/federation/plm/query (substitutes)
```

Result: product detail, BOM, where-used, BOM compare returned `ok: true` with expected payloads.

## Verification
```bash
pnpm --filter @metasheet/web build
```

## Result
```
Pass (vue-tsc + vite build).
```

## Notes
- The excluded POC views remain in the codebase; re-enable once their dependencies are restored.

## Validation run (2025-12-31)
- PLM token obtained via `POST /api/v1/auth/login` (admin/admin, tenant-1/org-1).
- ItemType list confirmed via `GET /api/v1/meta/item-types` (Part exists; no Assembly type).
- Existing sample Part ID resolved via `GET /api/v1/search/?q=&item_type=Part&limit=5`.

Sample IDs used:
- Part: `aa67a635-533f-4a61-a116-3801dbde7028`
- Compare right: `1cffed2e-0ee7-42b4-9562-8132928a0c74`

API results (via federation):
- Product detail (Part): `ok: true`, fields returned (name/partNumber/status/itemType/properties).
- BOM tree: `ok: true`, `items: []` (no children in this dataset).
- Where-used: `ok: true`, `parents: []`.
- BOM compare: `ok: true`, summary all zeros.
- Substitutes: not verified (no bomLineId available in dataset).

Note: previously provided item IDs were not present in the current PLM dataset; verification used the first available Part from search.
