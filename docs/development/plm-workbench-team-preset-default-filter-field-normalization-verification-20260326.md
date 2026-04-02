# PLM Workbench Team Preset Default Filter-Field Normalization Verification

## Scope

验证 `BOM / Where-Used` 默认团队预设在 route 上显式携带 `filterField=all` 时，不会再被误判成显式 blocker。

## Focused Checks

1. [plmWorkbenchViewState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmWorkbenchViewState.spec.ts)
   - `bomFilterField=all` 经 deferred patch 后返回 `false`
   - `whereUsedFilterField=all` 经 deferred patch 后返回 `false`
   - 非默认 field + 非空 filter 仍保持 `true`

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
