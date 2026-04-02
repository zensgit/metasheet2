# PLM Workbench Document Default Query Normalization Verification

## 变更文件

- `apps/web/src/views/plm/plmWorkbenchViewState.ts`
- `apps/web/src/views/PlmProductView.vue`
- `apps/web/tests/plmWorkbenchViewState.spec.ts`

## 回归点

- `documentSort=updated`、`documentSortDir=desc`、默认列 query 不再被当成显式 blocker
- 非默认文档排序或非空 filter 仍会阻断默认 `documentTeamView`
- deferred hydration patch 写入文档默认值时，不会误挡默认 auto-apply

## 验证命令

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmWorkbenchViewState.spec.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## 结果

- focused：`1` 个文件，`21` 个测试通过
- `type-check`：通过
- 全量：`59` 个文件，`439` 个测试通过
