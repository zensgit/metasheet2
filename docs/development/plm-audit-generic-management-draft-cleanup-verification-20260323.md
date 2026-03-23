# PLM Audit Generic Management Draft Cleanup Verification

## Scope

验证 generic `Share` / `Set default` 在命中当前 collaboration draft target 时，会正确完成 draft cleanup，而不是把旧 notice 留在页面上。

## Checks

- collaboration helper focused regression
- workspace type-check
- PLM audit regression suite

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm --filter @metasheet/web exec vitest run tests/plmAuditTeamViewCollaboration.spec.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Results

- `pnpm --filter @metasheet/web exec vitest run tests/plmAuditTeamViewCollaboration.spec.ts`
  - `1` file / `40` tests passed
- `pnpm --filter @metasheet/web type-check`
  - passed
- `pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`
  - `46` files / `298` tests passed

## Verified Outcome

- matching generic management actions clear the collaboration draft
- draft-owned single selection is cleared, while user-managed multi-select is preserved
- source-aware followup replacement still clears the draft through the same helper
- the old collaboration notice no longer survives a completed generic `Share` / `Set default`
