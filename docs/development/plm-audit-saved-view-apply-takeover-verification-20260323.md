# PLM Audit Saved-View Apply Takeover Verification

## Scope

验证 local saved view 接管时，`Apply saved view` 和 `Save current view` 现在共享同一套 collaboration owner cleanup，不会再留下旧 draft / followup。

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
  - `46` files / `299` tests passed

## Verified Outcome

- saved-view takeover clears collaboration draft and followup together
- draft-owned single selection is cleared, but user-managed multi-selection is preserved
- `Apply saved view` no longer depends on route watcher changes to clear old collaboration ownership
