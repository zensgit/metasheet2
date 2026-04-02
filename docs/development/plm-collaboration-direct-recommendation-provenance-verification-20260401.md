# PLM Collaboration Direct Recommendation Provenance Verification

## Commands

1. `pnpm --filter @metasheet/web exec vitest run tests/plmAuditTeamViewCollaboration.spec.ts`
2. `pnpm --filter @metasheet/web type-check`
3. `cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench-clean/apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`

## Results

- Focused collaboration spec: `1` file / `57` tests passed
- Type-check: passed
- Full PLM suite: `67` files / `707` tests passed

## Verified Behavior

- Direct recommendation `share` and `set-default` actions now preserve `sourceRecommendationFilter` even when no collaboration draft exists.
- Draft-driven collaboration actions continue to preserve recommendation provenance.
- Follow-up `set-default` actions preserve the original recommendation filter instead of falling back to the generic recommendation lane.
- Non-recommendation sources still emit no recommendation filter provenance.
