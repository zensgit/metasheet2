# PLM Workbench Default Query Normalization Verification

## Scope

验证 `workbench` 默认团队视角在 route 上显式携带 canonical no-op 默认值时，不会再被误判成显式 blocker。

## Focused Checks

1. [plmWorkbenchViewState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmWorkbenchViewState.spec.ts)
   - `whereUsedRecursive=true` / `whereUsedMaxLevels=5` 返回 `false`
   - `bomView=table` / `bomDepth=2` 返回 `false`
   - compare 默认值组合返回 `false`
   - 非默认值如 `compareSync=false`、`bomView=tree` 继续返回 `true`

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
