# PLM Workbench Audit Log Metadata Runtime Verification

## Focused Verification

- Extend `tests/plmWorkbenchClient.spec.ts`
- Mock `/api/plm-workbench/audit-logs` with `metadata.resourceTypes`
- Verify invalid values are filtered and canonical values are returned

## Regression Coverage

- Existing audit log normalization assertions remain green
- Full PLM frontend suite must still pass

## Commands

- `pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchClient.spec.ts`
- `pnpm --filter @metasheet/web type-check`
- `cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`
