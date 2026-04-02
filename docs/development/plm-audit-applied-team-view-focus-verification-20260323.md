# PLM Audit Applied Team View Focus Verification

## Scope

Verify that applying an audit team view replaces stale management focus with the applied team view instead of leaving prior draft/source residue active.

## Checks

- focused reducer coverage for `buildPlmAuditAppliedTeamViewAttentionState(...)`
- workspace type-check
- PLM audit regression suite

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm --filter @metasheet/web exec vitest run tests/plmAuditSavedViewAttention.spec.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Results

- `pnpm --filter @metasheet/web exec vitest run tests/plmAuditSavedViewAttention.spec.ts`
  - `1` file / `15` tests passed
- `pnpm --filter @metasheet/web type-check`
  - passed
- `pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`
  - `46` files / `295` tests passed

## Verified Outcome

- the new `Apply` attention helper sets `focusedAuditTeamViewId` to the applied view id
- recommendation focus, saved-view focus, and local saved-view followups are cleared
- collaboration followup cleanup no longer leaves `Apply` without a durable management anchor

## Result

- `type-check`: passed
- focused Vitest: `1` file / `15` tests passed
- full PLM/frontend Vitest: `46` files / `295` tests passed
