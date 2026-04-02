# PLM Workbench Approval Optimistic-Locking Verification

## Changed Files

- `packages/core-backend/src/routes/approvals.ts`
- `packages/core-backend/tests/unit/approvals-routes.test.ts`
- `packages/openapi/src/paths/approvals.yml`
- `packages/openapi/src/openapi.yml`

## Regression Points

- approve requires `body.version`
- reject requires `body.version`
- stale approve version returns `409 APPROVAL_VERSION_CONFLICT`
- stale reject version returns `409 APPROVAL_VERSION_CONFLICT`
- approve success returns `{ ok, data: { id, status, version, prevVersion } }`
- reject success returns `{ ok, data: { id, status, version, prevVersion } }`
- reject accepts `reason ?? comment`

## Verification Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/approvals-routes.test.ts tests/unit/approval-history-routing.test.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/core-backend build

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm exec tsx packages/openapi/tools/build.ts
```

## Result

- focused tests passed
  - `tests/unit/approvals-routes.test.ts`
  - `tests/unit/approval-history-routing.test.ts`
  - total: `2` files / `7` tests
- `pnpm --filter @metasheet/core-backend build`
  - passed
- `pnpm exec tsx packages/openapi/tools/build.ts`
  - passed
