# Multitable Sheet ACL Read Parity Verification

## Commands
- `pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-sheet-permissions.api.test.ts`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm lint`
- `pnpm type-check`

## Expected focus
- Users without global `multitable:read` but with sheet-level `spreadsheet:read` can open `/api/multitable/view`.
- Users without global `multitable:read` but with sheet-level `spreadsheet:write-own` can open `/api/multitable/form-context` and `/api/multitable/records/:recordId`.
- Users with neither global read nor sheet grant still receive `403`.
- Capabilities on these read routes stay narrowed to read-only behavior; no write-path elevation is introduced.
