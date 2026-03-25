# PLM Workbench Team Preset Selector Draft Cleanup Verification

## 覆盖文件
- 代码：
  - [`usePlmTeamFilterPresets.ts`](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamFilterPresets.ts)
- 回归：
  - [`usePlmTeamFilterPresets.spec.ts`](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamFilterPresets.spec.ts)

## 验证场景
- selector 从 `preset-a` 切到 `preset-b` 时：
  - `teamPresetName` 清空
  - `teamPresetGroup` 清空
  - `teamPresetOwnerUserId` 清空
- 既有 `non-manageable preset` owner cleanup 回归继续保持通过。

## Focused 回归
- `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamFilterPresets.spec.ts`
- 结果：`1` 文件 / `20` 测试通过

## 预期全量验证
- `pnpm --filter @metasheet/web type-check`
- `cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`

## 结论
- `team filter presets` 已经和 `team views` 对齐，不再把 rename/group/owner drafts 错绑到新 selector target。
