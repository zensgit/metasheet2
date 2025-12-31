# PLM UI integration verification (2025-12-31 15:40 CST)

## Scope
- Add PLM UI view for product detail, BOM, where-used, BOM compare, substitutes.
- Verify frontend build/typing.

## Manual check (optional)
```bash
pnpm --filter @metasheet/web dev
```
- Open `http://localhost:5173/plm`.
- Fill product/bom IDs and verify sections render results from `/api/federation/plm/*`.

## API smoke check (backend)
Core backend started with PLM env bindings (token + tenant/org):
```bash
DATABASE_URL=postgresql://metasheet:metasheet@localhost:5435/metasheet \
APP_PORT=7778 \
PLM_URL=http://127.0.0.1:7910 \
PLM_APIMODE=yuantus \
PLM_TENANTID=tenant-1 \
PLM_ORGID=org-1 \
PLM_USERNAME=admin \
PLM_PASSWORD=admin \
PLM_ITEMTYPE=Part \
PLM_MOCK=false \
PLM_APITOKEN=<token> \
PLM_TOKEN=<token> \
PLM_AUTHTOKEN=<token> \
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

Result: all endpoints returned `ok: true` with expected payloads.

## Verification
```bash
pnpm --filter @metasheet/web build
```

## Result
```
Failed: existing missing module/type declarations in Univer POC views and workflow designer.
Errors:
- src/views/UniverGridPOC.vue: missing @univerjs CSS imports and helper modules
- src/views/UniverKanbanPOC.vue: missing @univerjs CSS imports and helper modules
- src/views/WorkflowDesigner.vue: missing bpmn-js CSS imports
```

## Notes
- The build failure is pre-existing and unrelated to the PLM UI view changes.
- PLM UI view compiles within the existing app structure, but full build is blocked by the above unresolved dependencies.
