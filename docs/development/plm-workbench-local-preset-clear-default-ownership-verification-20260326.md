# PLM Workbench Local Preset Clear-Default Ownership Verification

## 变更范围

- `apps/web/src/views/plm/plmLocalPresetOwnership.ts`
- `apps/web/src/views/PlmProductView.vue`
- `apps/web/tests/plmLocalPresetOwnership.spec.ts`

## 回归点

### 1. clear-default 被纳入 local-owner action 合同

新增断言：

- `shouldClearLocalPresetOwnerAfterTeamPresetAction('clear-default', result)` 在 surviving target 存在时返回 truthy
- `runPlmLocalPresetOwnershipAction(...)` 会因此调用 `clearLocalOwner`

这锁住了 BOM / Where-Used wrapper 这次补上的 handoff 语义。

### 2. page wrapper 不再绕过 ownership helper

`PlmProductView.vue` 里的：

- `clearBomTeamPresetDefault()`
- `clearWhereUsedTeamPresetDefault()`

现在都通过 `runPlmLocalPresetOwnershipAction(...)` 走同一套 deferred clear 逻辑，不再是仅剩的 direct bypass。

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
