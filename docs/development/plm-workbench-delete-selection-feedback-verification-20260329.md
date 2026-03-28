# PLM Workbench Delete Selection Feedback Verification

## Focused Verification

- Add one regression in `tests/usePlmTeamViews.spec.ts`
- Add one regression in `tests/usePlmTeamFilterPresets.spec.ts`
- Call delete without a selected target
- Verify no mutation request is sent and the correct selection-required message is emitted

## Regression Coverage

- Keep existing delete, archive, restore, and pending-management tests green
- Re-run the full PLM frontend suite

## Commands

- `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts tests/usePlmTeamFilterPresets.spec.ts`
- `pnpm --filter @metasheet/web type-check`
- `cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`
