# PLM Collaboration Provenance Normalizer Unification Verification

## Commands

1. `pnpm --filter @metasheet/web exec vitest run tests/plmAuditTeamViewCollaboration.spec.ts`
2. `pnpm --filter @metasheet/web type-check`
3. `cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench-clean/apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`

## Results

- Focused collaboration spec: `1` file / `58` tests passed
- Type-check: passed
- Full PLM suite: `67` files / `708` tests passed

## Verified Behavior

- collaboration draft builder now reuses the canonical recommendation provenance normalizer
- collaboration followup builder now reuses the same normalizer
- recommendation provenance still preserves explicit filters like `recent-default`
- missing recommendation provenance still normalizes to `''`
- non-recommendation sources still emit no recommendation provenance
