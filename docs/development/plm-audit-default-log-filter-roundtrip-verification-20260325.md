# PLM Audit Default-Log Filter Roundtrip Verification

## 范围

验证 audit team view 在保存和重新读取时，能够稳定保留：

- `action = set-default`
- `action = clear-default`
- `resourceType = plm-team-view-default`

## 回归

更新：

- [plmWorkbenchClient.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmWorkbenchClient.spec.ts)

覆盖点：

1. `savePlmWorkbenchTeamView('audit', ...)` 返回的 `saved.state` 仍保留 `set-default + plm-team-view-default`
2. `listPlmWorkbenchTeamViews('audit')` 返回的 `state` 仍保留 `clear-default + plm-team-view-default`

## 执行

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchClient.spec.ts tests/plmAuditQueryState.spec.ts tests/plmAuditTeamViewAudit.spec.ts

pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## 结果

- focused：见本轮提交后的回归结果
- `type-check`：通过
- 全量：见本轮提交后的整体回归

结论：audit team view 的默认日志筛选现在可以稳定 round-trip，不再被 client normalize 分支错误清空。
