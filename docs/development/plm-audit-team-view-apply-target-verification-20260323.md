# PLM Audit Team View Apply Target Verification

## Scope

Verify that `Apply` continues to bridge the local selector into the canonical route, while generic management actions stay locked to canonical ownership.

## Focused Checks

### Apply target resolution

`apps/web/tests/plmAuditTeamViewControlTarget.spec.ts`

- prefers the local selector over the canonical owner
- falls back to the canonical owner when the selector is empty
- falls back to the canonical owner when the selected id is stale

## Commands

```bash
pnpm --filter @metasheet/web type-check
cd apps/web && pnpm exec vitest run tests/plmAuditTeamViewControlTarget.spec.ts
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Result

- `type-check`: passed
- focused Vitest: `1` file / `8` tests passed
- full PLM/frontend Vitest: `46` files / `293` tests passed
