# PLM Workbench Panel Preset Hydration Takeover Verification

## 变更文件

- `apps/web/src/views/PlmProductView.vue`
- `apps/web/src/views/plm/plmHydratedTeamPresetOwnerTakeover.ts`
- `apps/web/tests/plmHydratedTeamPresetOwnerTakeover.spec.ts`

## 回归点

- hydration 读到新的显式 `bomTeamPreset / whereUsedTeamPreset` 时：
  - 不同于本地 selector：清 selector / draft / selection
  - 等于本地 selector：保留现状
  - route 无 owner：保留现状

## 验证命令

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmHydratedTeamPresetOwnerTakeover.spec.ts tests/usePlmTeamFilterPresets.spec.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## 结果

- focused：`2` 个文件，`39` 个测试通过
- `type-check`：通过
- 全量：`59` 个文件，`435` 个测试通过
