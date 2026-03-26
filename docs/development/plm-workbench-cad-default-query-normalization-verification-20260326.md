# PLM Workbench CAD Default Query Normalization Verification

## Scope

验证 `CAD` 默认团队视角在 route 上显式携带空 query 值时，不会再被误判成 auto-apply blocker。

## Focused Checks

1. [plmWorkbenchViewState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmWorkbenchViewState.spec.ts)
   - `cadReviewState=''` + `cadReviewNote='   '` 返回 `false`
   - deferred patch 后的空 CAD state 仍返回 `false`
   - 非空 `cadFileId` 或 `cadReviewState='approved'` 继续返回 `true`

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmWorkbenchViewState.spec.ts
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Expected Result

- focused spec 通过
- web type-check 通过
- 前端全量 spec 继续通过
