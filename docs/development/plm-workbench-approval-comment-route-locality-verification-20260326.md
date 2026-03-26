# PLM Workbench Approval Comment Route Locality Verification

## 变更范围

- `apps/web/src/views/PlmProductView.vue`
- `apps/web/src/views/plm/plmWorkbenchViewState.ts`
- `apps/web/tests/plmWorkbenchViewState.spec.ts`

## 回归点

### 1. local route snapshot 不再携带 approvalComment

`plmWorkbenchViewState.spec.ts` 新增断言：

- `normalizePlmWorkbenchLocalRouteQuerySnapshot(...)` 会保留 `workbenchTeamView`
- 会保留本地 `bomFilterPreset / whereUsedFilterPreset`
- 会删除 `approvalComment`
- 会继续 canonicalize `panel`

这保证复制 deep-link 时，approval comment 不会再泄漏到 URL。

### 2. legacy route approvalComment 会被 authoritative 清理

`plmWorkbenchViewState.spec.ts` 新增断言：

- `buildPlmWorkbenchLegacyLocalDraftQueryPatch({ approvalComment: 'ship-it' })`
  返回 `{ approvalComment: '' }`
- 没有该字段时返回空 patch

这保证旧 URL 打开后，页面会清理陈旧 approval draft query，而不是再把它 hydration 回本地输入框。

### 3. approvals 默认 blocker 合同保持稳定

已有 `plmWorkbenchViewState.spec.ts` 断言继续通过：

- `approvalComment` 不会被当成 workbench default auto-apply blocker
- `approvalComment` 不会被当成 approvals default auto-apply blocker

这说明这轮 route-locality 修复没有把已有 default blocker 合同带回去。

## 执行记录

### Focused

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmWorkbenchViewState.spec.ts
```

结果：

- `1` 个文件 / `27` 个测试通过

### Type Check

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
```

结果：

- 通过

### Frontend Full

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

结果：

- `59` 个文件 / `453` 个测试通过
