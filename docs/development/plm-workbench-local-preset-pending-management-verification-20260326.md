# PLM Workbench Local Preset Pending Management Verification

## 变更文件

- `apps/web/src/views/plm/usePlmTeamFilterPresets.ts`
- `apps/web/src/views/PlmProductView.vue`
- `apps/web/tests/usePlmTeamFilterPresets.spec.ts`

## 回归点

- 本地 preset owner active 且 team preset selector 非空时：
  - `canRename / canClearDefault` 等管理权限冻结
  - `clearTeamPresetDefault()` 不会打 API
  - 提示为“请先应用…团队预设，再执行管理操作”
- `Apply` 仍保持可用

## 验证命令

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/usePlmTeamFilterPresets.spec.ts tests/plmLocalPresetOwnership.spec.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## 结果

- focused：`2` 个文件，`43` 个测试通过
- `type-check`：通过
- 全量：`58` 个文件，`432` 个测试通过
