# PLM Audit Removed Team View Ownership Cleanup Verification

## Verified Behavior

- 删除 team view 时，不再保留指向该 view 的 collaboration draft。
- 删除 team view 时，不再保留指向该 view 的 collaboration followup。
- 删除 team view 时，不再保留指向该 view 的 shared-entry ownership。
- generic delete 路径在 route 不变化时，也不会留下 invisible canonical owner 来锁住后续 controls。

## Focused Validation

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
```

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmAuditTeamViewCollaboration.spec.ts tests/plmAuditTeamViewShareEntry.spec.ts tests/plmAuditTeamViewControlTarget.spec.ts
```

Actual result:

- `type-check` passed
- focused Vitest run passed with `3` files and `53` tests

## Full Regression

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Actual result:

- full PLM frontend regression passed
- `45` files and `278` tests passed
