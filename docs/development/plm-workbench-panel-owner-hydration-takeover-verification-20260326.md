# PLM Workbench Panel Owner Hydration Takeover Verification

## 变更文件

- `apps/web/src/views/PlmProductView.vue`
- `apps/web/src/views/plm/plmHydratedTeamViewOwnerTakeover.ts`
- `apps/web/tests/plmHydratedTeamViewOwnerTakeover.spec.ts`

## 回归点

- route hydration 读到新的显式 panel owner 时：
  - 不同于本地 selector：清 selector / draft / selection
  - 等于本地 selector：保留现状
  - route 无 owner：保留现状

## 验证命令

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmHydratedTeamViewOwnerTakeover.spec.ts tests/usePlmTeamViews.spec.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## 结果

- focused：`2` 个文件，`47` 个测试通过
- `type-check`：通过
- 全量：`58` 个文件，`431` 个测试通过
