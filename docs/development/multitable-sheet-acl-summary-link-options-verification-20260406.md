# Multitable Sheet ACL Summary/Link Options Verification

## Commands
- `pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-sheet-permissions.api.test.ts`
- `pnpm --filter @metasheet/core-backend build`

## Expected focus
- `records-summary` succeeds with sheet-level readable grants even when global `multitable:read` is absent.
- `link-options` succeeds only when both the source sheet and foreign target sheet are readable via sheet grants or broader global permissions.
- Existing negative cases still return `403` when sheet scope does not confer readable access.
