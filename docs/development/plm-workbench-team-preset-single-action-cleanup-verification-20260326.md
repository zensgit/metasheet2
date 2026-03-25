# PLM Workbench Team Preset Single-Action Cleanup Verification

## 覆盖文件
- 代码：
  - [`usePlmTeamFilterPresets.ts`](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamFilterPresets.ts)
- 回归：
  - [`usePlmTeamFilterPresets.spec.ts`](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamFilterPresets.spec.ts)

## 验证场景
- single `archiveTeamPreset()`：
  - 清空当前 `teamPresetKey`
  - 清掉同 id `teamPresetSelection`
  - 清掉 stale `teamPresetOwnerUserId`
- single `deleteTeamPreset()`：
  - 清空当前 `teamPresetKey`
  - 清掉同 id `teamPresetSelection`
  - 清掉 stale `teamPresetOwnerUserId`
- single `transferTeamPreset()`：
  - 如果保存后的 preset 失去 manageability，会把同 id 从 `teamPresetSelection` 移除

## Focused 回归
- `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamFilterPresets.spec.ts`
- 结果：`1` 文件 / `19` 测试通过

## 预期后续验证
- `pnpm --filter @metasheet/web type-check`
- `cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`

## 结论
- `team filter presets` 的 single action cleanup 现在和 `team views` 对齐。
- 这次修复消除了 archive/delete/transfer 后的 selection residue 和 owner draft residue，不再出现“目标已不可管理，但页面仍显示已选或保留旧 owner 草稿”的状态漂移。
