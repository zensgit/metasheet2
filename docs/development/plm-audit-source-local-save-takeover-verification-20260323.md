# PLM Audit Source Local Save Takeover Verification

## Scope

验证 source-aware local save 在安装 saved-view followup 前，会先消费旧的 collaboration draft / followup ownership。

## Checks

- collaboration helper focused regression
- workspace type-check
- PLM audit regression suite

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm --filter @metasheet/web exec vitest run \
  tests/plmAuditTeamViewCollaboration.spec.ts \
  tests/plmAuditSavedViewShareFollowup.spec.ts \
  tests/plmAuditTeamViewShareEntry.spec.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Results

- `pnpm --filter @metasheet/web exec vitest run tests/plmAuditTeamViewCollaboration.spec.ts tests/plmAuditSavedViewShareFollowup.spec.ts tests/plmAuditTeamViewShareEntry.spec.ts`
  - `3` files / `58` tests passed
- `pnpm --filter @metasheet/web type-check`
  - passed
- `pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`
  - `46` files / `297` tests passed

## Verified Outcome

- source-local-save takeover clears collaboration draft ownership
- source-local-save takeover clears collaboration followup ownership
- draft-owned single selection is cleared, but user-managed multi-select is preserved
- the saved-view local followup becomes the only transient owner after a source-aware local save
