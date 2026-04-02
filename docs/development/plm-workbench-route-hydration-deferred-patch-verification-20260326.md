# PLM Workbench Route Hydration Deferred Patch Verification

## 变更范围

- `apps/web/src/views/PlmProductView.vue`
- `apps/web/src/views/plm/plmRouteHydrationPatch.ts`
- `apps/web/tests/plmRouteHydrationPatch.spec.ts`

## 回归点

### 1. hydration 期间 patch 会合并而不是丢失

新增纯函数断言：

- 已有 deferred patch 时，再写入新的 query patch，会按 key 合并
- 同一 key 的新值会覆盖旧值

### 2. 只有最后一轮 hydration 结束后才 flush

新增断言：

- `hasPendingHydration = true` 时返回 `pendingPatch`
- `hasPendingHydration = false` 时返回 `flushPatch`

这锁住了 `PlmProductView.vue` 当前的控制流：

- hydration 中缓存 patch
- 最后一轮 apply 结束后统一 `syncQueryParams(...)`

## 执行记录

### Focused

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmLocalPresetOwnership.spec.ts tests/usePlmTeamFilterPresets.spec.ts tests/plmRouteHydrationPatch.spec.ts tests/plmWorkbenchViewState.spec.ts
```

结果：

- `4` 个文件
- `61` 个测试通过

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

- 待本轮最终提交前统一执行
