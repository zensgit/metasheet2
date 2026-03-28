# PLM Workbench Approval Route Error Contract Verification

## Scope

- `packages/core-backend/src/routes/approvals.ts`
- `packages/core-backend/tests/unit/approvals-routes.test.ts`
- `packages/openapi/src/paths/approvals.yml`
- `packages/openapi/dist/openapi.yaml`
- `packages/openapi/dist/openapi.json`
- `packages/openapi/dist/combined.openapi.yml`

## Checks

1. `approve/reject` 的 `401/404/400/500` route-owned 错误都返回 `ok:false/error:{code,message}`。
2. `approve/reject` 的 OpenAPI source 补齐真实存在的 `404/503` 响应。
3. 后端 focused test 覆盖 `401`、`404`、invalid status、reject reason required。

## Validation Commands

- `cd packages/core-backend && pnpm exec vitest run tests/unit/approvals-routes.test.ts`
- `cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench && pnpm exec tsx packages/openapi/tools/build.ts`
- `cd packages/core-backend && pnpm build`
