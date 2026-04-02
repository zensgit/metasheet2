# PLM Workbench Reset Hydrated Query Purge Verification

## 变更范围

- `apps/web/src/views/plm/plmWorkbenchViewState.ts`
- `apps/web/src/views/PlmProductView.vue`
- `apps/web/tests/plmWorkbenchViewState.spec.ts`

## 回归点

新增 focused regression：

- `buildPlmWorkbenchResetHydratedPanelQueryPatch()` 必须同时清掉：
  - `workbenchTeamView`
  - `documentTeamView`
  - `cadTeamView`
  - `approvalsTeamView`
  - `documentSort`
  - `documentSortDir`
  - `documentColumns`
  - `cadReviewState`
  - `cadReviewNote`
  - `approvalComment`
  - `approvalSort`
  - `approvalSortDir`
  - `approvalColumns`

## 执行记录

### Focused

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmWorkbenchViewState.spec.ts
```

结果：

- `1` 个文件
- `15` 个测试通过

### Type Check

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
```

结果：

- 通过

### Full

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

结果：

- `56` 个文件
- `417` 个测试通过
