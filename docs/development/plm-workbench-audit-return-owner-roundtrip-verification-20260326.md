# PLM Workbench Audit Return Owner Roundtrip Verification

## 变更文件

- `apps/web/src/views/plm/plmWorkbenchViewState.ts`
- `apps/web/tests/plmWorkbenchViewState.spec.ts`

## 回归点

- `buildPlmWorkbenchRoutePath(...)` 现在会在 `returnToPlmPath` 中保留 explicit `workbenchTeamView`
- 同时继续剥离：
  - `bomFilterPreset`
  - `whereUsedFilterPreset`
  - `approvalComment`
- `panel` 继续做 canonical 顺序归一化

## 验证命令

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmWorkbenchViewState.spec.ts tests/plmWorkbenchSceneAudit.spec.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## 结果

- focused：`2` 个文件，`21` 个测试通过
- `type-check`：通过
- 全量：`57` 个文件，`428` 个测试通过
