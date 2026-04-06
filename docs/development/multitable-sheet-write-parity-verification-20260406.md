# Multitable Sheet Write Parity Verification

## Commands
- `pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-sheet-permissions.api.test.ts`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm lint`
- `pnpm type-check`

## Expected focus
- Users without global `multitable:write` but with sheet `spreadsheet:write-own` can create, form-submit, patch, and delete owned records through the multitable API.
- Users with sheet `spreadsheet:read` remain read-only and do not gain record mutation capabilities.
- `write-own` keeps row-level enforcement: owned rows can be mutated, foreign rows still return `403`.
- Field/view/schema management remains unavailable to sheet-scoped writers unless separately granted.
