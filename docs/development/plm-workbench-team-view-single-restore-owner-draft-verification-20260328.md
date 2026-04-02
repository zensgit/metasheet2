# PLM Workbench Team View Single Restore Owner Draft Verification

## Focused Verification

- Add a regression in `tests/usePlmTeamViews.spec.ts`
- Seed stale `teamViewName` and `teamViewOwnerUserId`
- Run single `restoreTeamView()`
- Verify both drafts are cleared after success

## Regression Coverage

- Keep existing restore/apply behavior intact
- Full PLM frontend suite must stay green

## Commands

- `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts tests/plmWorkbenchClient.spec.ts`
- `pnpm --filter @metasheet/web type-check`
- `cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`
