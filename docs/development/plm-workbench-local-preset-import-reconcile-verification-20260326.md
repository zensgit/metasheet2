# PLM Workbench Local Preset Import Reconcile Verification

## 变更范围

- `apps/web/src/views/plm/plmLocalFilterPresetRouteIdentity.ts`
- `apps/web/src/views/PlmProductView.vue`
- `apps/web/tests/plmLocalFilterPresetRouteIdentity.spec.ts`

## 回归点

### 1. helper 支持“清 route owner 但保留 selector”

新增断言：

- 当 stale route owner 与 selector 同 key，但调用方显式要求 `preserveSelectedPresetKeyOnClear` 时
- helper 会返回：
  - `nextRoutePresetKey = ''`
  - `nextSelectedPresetKey = 原 selector key`

这锁住了 import 场景需要的 handoff 语义。

### 2. 导入路径显式执行 reconcile

`PlmProductView.vue` 的 BOM / Where-Used share import 与 JSON import 在合并 presets 后，现在都会调用：

- `reconcileBomLocalFilterPresetIdentityAfterImport()`
- `reconcileWhereUsedLocalFilterPresetIdentityAfterImport()`

这样就算 preset 是同 key in-place 更新，也会立刻评估 route owner 是否还匹配当前 live filter。

## 执行记录

### Focused

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmLocalFilterPresetRouteIdentity.spec.ts tests/plmTeamFilterPresetStateMatch.spec.ts tests/plmWorkbenchViewState.spec.ts
```

结果：

- `3` 个文件
- `26` 个测试通过

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
- `427` 个测试通过
