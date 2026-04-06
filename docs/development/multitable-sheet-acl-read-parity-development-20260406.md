# Multitable Sheet ACL Read Parity Development

## Scope
- Extend sheet-level ACL read grants from `/api/multitable/context` to the remaining core read surfaces:
  - `/api/multitable/view`
  - `/api/multitable/form-context`
  - `/api/multitable/records/:recordId`
- Keep the slice read-only. No import/export, manager surfaces, or write-path elevation.

## Changes
- Added `resolveSheetReadableCapabilities()` in [univer-meta.ts](/private/tmp/metasheet2-sheet-acl-read-parity-20260406/packages/core-backend/src/routes/univer-meta.ts) to reuse the existing sheet-scope map with `applyContextSheetReadGrant()`.
- Removed `rbacGuard('multitable', 'read')` from the three target routes and replaced it with route-local checks:
  - return `401` when `access.userId` is missing
  - return `403` when neither global multitable read nor a sheet-level readable grant is present
- Reused the existing scoped capability model so these routes still return read-only capabilities when the caller only has `spreadsheet:read` or `spreadsheet:write-own`.
- Added integration coverage in [multitable-sheet-permissions.api.test.ts](/private/tmp/metasheet2-sheet-acl-read-parity-20260406/packages/core-backend/tests/integration/multitable-sheet-permissions.api.test.ts) for:
  - `view` with sheet read grant
  - `form-context` and `records/:recordId` with sheet `write-own` grant
  - the shared `403` path when no grant exists

## Notes
- This slice intentionally does not change `/records-summary`, `/fields/:fieldId/link-options`, or attachment download routes.
- `write-own` continues to unlock read access only on these routes; it does not escalate create/edit/delete on its own.
