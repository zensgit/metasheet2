# PLM Workbench Approvals Default Query Normalization Verification

## 变更文件

- `apps/web/src/views/plm/plmWorkbenchViewState.ts`
- `apps/web/src/views/PlmProductView.vue`
- `apps/web/tests/plmWorkbenchViewState.spec.ts`

## 回归点

- `approvalsStatus=pending`、`approvalSort=created`、`approvalSortDir=desc`、默认列 query 不再被当成显式 blocker
- `approvalComment` 继续不阻断默认 `approvalsTeamView`
- 非默认审批状态、非默认排序、非默认列仍会阻断默认 auto-apply

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

- focused：`1` 个文件，`22` 个测试通过
- `type-check`：通过
- 全量：`59` 个文件，`440` 个测试通过
