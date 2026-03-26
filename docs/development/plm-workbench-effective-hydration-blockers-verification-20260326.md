# PLM Workbench Effective Hydration Blockers Verification

## 变更范围

- `apps/web/src/views/plm/plmRouteHydrationPatch.ts`
- `apps/web/tests/plmRouteHydrationPatch.spec.ts`
- `apps/web/src/views/PlmProductView.vue`

## 回归点

### 1. deferred patch 可以产出 effective hydration query

新增断言：

- 当前 route query 上存在 `documentTeamView/documentFilter`
- deferred patch 把它们清掉，并新增 `cadTeamView`
- 结果只保留真正生效后的 query

这锁住了 blocker 读取 effective query 的基础合同。

### 2. documents / cad / approvals / workbench blocker 统一看 effective state

`PlmProductView.vue` 里的：

- `hasExplicitQueryKey(...)`
- `hasExplicitWorkbenchQueryState()`
- approvals `shouldAutoApplyDefault`

现在全部基于 deferred patch overlay 后的 effective query 计算，不再直接读取原始 `route.query`。

## 执行记录

### Focused

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmRouteHydrationPatch.spec.ts tests/plmWorkbenchViewState.spec.ts tests/plmAuditQueryState.spec.ts
```

结果：

- `3` 个文件
- `28` 个测试通过

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

- `57` 个文件
- `428` 个测试通过
