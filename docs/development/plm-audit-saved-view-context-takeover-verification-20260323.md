# PLM Audit Saved-View Context Takeover Verification

## Scope

验证 saved-view context quick action 现在会像 `Apply saved view` 一样接管旧的 collaboration owner，而不是在 route 不改 canonical `teamViewId` 时留下旧 draft。

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

- saved-view context quick actions now reuse the same takeover cleanup as `Apply saved view`
- draft-owned single-row selection is cleared before a saved-view takeover installs its own state
- route no-op paths no longer depend on watcher cleanup to remove stale collaboration draft ownership
