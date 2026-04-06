# Multitable Record Patch Write Parity Verification

## Commands
- `pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-sheet-permissions.api.test.ts`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm lint`
- `pnpm type-check`

## Expected focus
- Users without global `multitable:write` but with sheet `spreadsheet:write-own` can patch their own records through `/api/multitable/records/:recordId`.
- The same users still receive `403` when patching foreign rows.
- `spreadsheet:read` remains unable to patch records.
- The direct patch route now aligns with the other sheet-scoped write parity routes on `401`/`403` semantics.
