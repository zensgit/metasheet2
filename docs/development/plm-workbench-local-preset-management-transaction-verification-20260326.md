# PLM Workbench Local Preset Management Transaction Verification

## 变更范围

- `apps/web/src/views/plm/usePlmTeamFilterPresets.ts`
- `apps/web/src/views/PlmProductView.vue`
- `apps/web/tests/usePlmTeamFilterPresets.spec.ts`

## 回归点

### 1. team preset actions 返回 canonical success/null

新增/收紧断言：

- `applyTeamPreset()` 成功时返回被应用的 preset
- `saveTeamPreset()` 成功时返回保存后的 preset
- `applyTeamPreset()` 被 `canApply=false` 拦住时返回 `null`
- `saveTeamPreset()` 后端失败时返回 `null`

这样 page wrapper 才能可靠地用 `Boolean(result)` 决定是否清本地 owner。

### 2. deferred local owner clear 真正生效

本轮实现把 `PlmProductView.vue` 的 BOM / Where-Used team preset wrapper 统一切到：

- 成功结果才 clear local owner
- 失败 / early-return / empty batch 不 clear

## 执行记录

### Focused

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/usePlmTeamFilterPresets.spec.ts tests/plmLocalPresetOwnership.spec.ts
```

结果：

- `2` 个文件
- `38` 个测试通过

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
- `416` 个测试通过
