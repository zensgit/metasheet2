# PLM Workbench Team Preset Clear-Default Result Verification

## 变更范围

- `apps/web/src/views/plm/usePlmTeamFilterPresets.ts`
- `apps/web/tests/usePlmTeamFilterPresets.spec.ts`

## 回归点

### 1. clear-default 返回 canonical success/null

新增/收紧断言：

- `clearTeamPresetDefault()` 成功后返回 surviving preset
- blocked/no-op/失败 path 仍保持 `null`

这把 page wrapper 依赖的 `Boolean(result)` 合同真正锁住了。

### 2. requested identity 与 apply target 继续保持一致

原有 `sync requested preset id after save, set-default, and clear-default actions` 回归现在额外断言：

- `clearTeamPresetDefault()` 的返回值 `id === preset-saved`

说明 action 在成功后不仅重新应用 surviving preset，也会把同一条 canonical target 显式返回给上层。

## 执行记录

### Focused

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/usePlmTeamFilterPresets.spec.ts tests/plmLocalPresetOwnership.spec.ts
```

结果：

- `2` 个文件
- `42` 个测试通过

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
