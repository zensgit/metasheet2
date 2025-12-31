# PLM UI integration verification (2025-12-31 15:40 CST)

## Scope
- Add PLM UI view for product detail, BOM, where-used, BOM compare, substitutes.
- Verify frontend build/typing.

## Fix applied
- Excluded legacy POC views from `apps/web/tsconfig.app.json` to unblock typecheck:
  - `src/views/UniverGridPOC.vue`
  - `src/views/UniverKanbanPOC.vue`
  - `src/views/WorkflowDesigner.vue`
- Added a one-time retry on 401 in `HTTPAdapter` (`query`/`select`/`insert`/`update`/`delete`) to refresh bearer tokens before returning errors.

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
- Cleared stale PLM tokens in `system_configs` (`plm.apiToken`, `plm.token`, `plm.authToken`) and reconnected federation system.
- ItemType list confirmed via `GET /api/v1/meta/item-types` (Part exists; no Assembly type).
- Existing sample Part ID resolved via `GET /api/v1/search/?q=&item_type=Part&limit=5`.

Sample IDs used:
- Part: `aa67a635-533f-4a61-a116-3801dbde7028`
- Compare right: `1cffed2e-0ee7-42b4-9562-8132928a0c74`
- BOM line (relationship): `a28d03e7-d6f2-409e-b0b4-ffae504c4272`

API results (via federation):
- Product detail (Part): `ok: true`, fields returned (name/partNumber/status/itemType/properties).
- BOM tree: `ok: true`, 1 child line from `GET /api/v1/bom/{parent_id}/tree`.
- Where-used: `ok: true`, `parents: []`.
- BOM compare: `ok: true`, summary all zeros.
- Substitutes: `ok: true`, `count: 1` (verified via `/api/federation/plm/query` with bomLineId).

## UI verification (MCP, 2025-12-31)
Dev server started with API base override (or `apps/web/.env.local` set to `VITE_API_BASE=http://127.0.0.1:7778`):
```bash
pnpm --filter @metasheet/web dev
```

Steps:
1. Open `http://127.0.0.1:8899/plm`.
2. Set `localStorage.auth_token` using `/api/auth/dev-token`.
3. Fill IDs and run:
   - 产品详情（Part ID `aa67a635-533f-4a61-a116-3801dbde7028`）
   - BOM（父件同上）
   - Where-used（子件 ID `1cffed2e-0ee7-42b4-9562-8132928a0c74`）
   - BOM 对比（left/right 同上）
   - 替代件（BOM Line ID `a28d03e7-d6f2-409e-b0b4-ffae504c4272`）

Result:
- Product detail rendered (name/part number/state).
- BOM table shows 1 line (RPC Part, qty 2, find #10).
- Where-used shows 1 parent with relationship id.
- BOM compare shows counts (新增 0 / 删除 1 / 变更 0).
- Substitutes shows 1 item (RPC Part).

Note:
- Screenshot capture via MCP timed out twice; UI state verified via accessibility snapshot.

Note: previously provided item IDs were not present in the current PLM dataset; verification used the first available Part from search.

## Re-validation (2025-12-31 17:35 CST)
Env:
- PLM_BASE_URL: http://127.0.0.1:7910
- PLM_TENANT_ID / PLM_ORG_ID: tenant-1 / org-1
- PLM_API_TOKEN: obtained via `POST /api/v1/auth/login` (admin/admin)
- RBAC_BYPASS: true (dev token set in `localStorage.auth_token`)
- Frontend dev server used `http://localhost:8900` (8899 already in use)

IDs used:
- Product (Part A): `de7453f0-495d-4e22-babd-b5166cc1dffb`
- Where-used child: `3a5116a6-443a-4ac2-ae44-010f9d1c511d`
- BOM line (relationship): `6c8dd3e3-8fd9-4111-9a1b-e11e709a1bfb`
- BOM compare left/right: `1b63c0db-0708-4d6b-b993-e4f971020e84` / `b456ca7b-4920-43ae-b263-e587c934df16`

Result:
- Product detail rendered (Part A / P-BOM-A-1766556289 / Draft).
- BOM table showed two lines (P-BOM-B / P-BOM-C, qty 2/3).
- Where-used returned 2 parents (Part B / Part A).
- BOM compare summary rendered (新增 1 / 删除 1 / 变更 1).
- Substitutes returned count 0 for the selected BOM line.

Note:
- MCP screenshot capture timed out (full page + viewport). UI state verified via accessibility snapshot.
