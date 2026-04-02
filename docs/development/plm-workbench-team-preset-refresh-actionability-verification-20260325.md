# PLM Workbench Team Preset Refresh Actionability Verification

## 范围

验证 team preset refresh 现在会按 applyability / manageability 对齐本地 ownership。

## 回归

更新：

- [usePlmTeamFilterPresets.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamFilterPresets.spec.ts)

覆盖点：

1. refresh 后如果 preset 仍存在但 `canApply = false`，会清掉 `teamPresetKey` 和 `requestedPresetId`
2. refresh 后如果 preset 仍存在但 `canManage = false`，会清掉 stale `teamPresetSelection`

## 执行

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamFilterPresets.spec.ts

pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## 结果

- focused：见本轮提交后的回归结果
- `type-check`：通过
- 全量：见本轮提交后的整体回归

结论：team preset refresh 已经不会再保留 stale selector/requested id/selection，actionability 语义和 team views 对齐。
