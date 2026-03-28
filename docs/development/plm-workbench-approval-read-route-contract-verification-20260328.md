# PLM Workbench approval read-route contract verification

## Scope

- `packages/core-backend/src/routes/approvals.ts`
- `packages/core-backend/tests/unit/approvals-routes.test.ts`
- `packages/openapi/src/paths/approvals.yml`
- `packages/openapi/dist/openapi.yaml`
- `packages/openapi/dist/openapi.json`
- `packages/openapi/dist/combined.openapi.yml`

## Checks

1. `GET /api/approvals/pending` returns structured `APPROVAL_USER_REQUIRED` when the actor id is missing.
2. `GET /api/approvals/:id` returns structured `APPROVAL_NOT_FOUND` when the approval instance does not exist.
3. OpenAPI source/dist include `/api/approvals/pending` and the detail-route `401/403/404/503` response surface.

## Validation commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/core-backend
pnpm exec vitest run tests/unit/approvals-routes.test.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm exec tsx packages/openapi/tools/build.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/core-backend
pnpm build
```
