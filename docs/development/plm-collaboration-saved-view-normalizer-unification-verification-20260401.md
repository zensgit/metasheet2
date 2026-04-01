# PLM Collaboration Saved-View Normalizer Unification Verification

## Commands

1. `pnpm --filter @metasheet/web exec vitest run tests/plmAuditTeamViewCollaboration.spec.ts`
2. `pnpm --filter @metasheet/web type-check`
3. `cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench-clean/apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`

## Results

- Focused collaboration spec: `1` file / `59` tests passed
- Type-check: passed
- Full PLM suite: `67` files / `709` tests passed

## Verified Behavior

- collaboration draft builder now reuses the canonical saved-view provenance normalizer
- collaboration followup builder now reuses the same normalizer
- saved-view promotion keeps explicit `sourceSavedViewId`
- non-promotion sources still normalize saved-view provenance to `null`
