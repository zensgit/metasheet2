# PLM Workbench Team Preset Deferred Auto-Apply Verification

## 变更文件

- `apps/web/src/views/plm/plmWorkbenchViewState.ts`
- `apps/web/src/views/PlmProductView.vue`
- `apps/web/tests/plmWorkbenchViewState.spec.ts`

## 回归点

- deferred patch 写入 `bomFilterPreset / bomFilter / bomFilterField` 时，BOM 默认 team preset 视为被显式 blocker 阻断
- deferred patch 删除这些 query key 后，BOM 默认 team preset blocker 解除
- Where-Used 同样遵循这套规则

## 验证命令

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmWorkbenchViewState.spec.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## 结果

- focused：`1` 个文件，`19` 个测试通过
- `type-check`：通过
- 全量：`59` 个文件，`437` 个测试通过
