# Multitable Record Patch Write Parity Development

## Scope
- Extend sheet-scoped write parity to the direct single-record patch route:
  - `/api/multitable/records/:recordId`
- Keep the slice narrowly focused on direct record editing. Attachment upload/delete and other remaining write paths stay out of scope.

## Changes
- Removed the route-level global `rbacGuard('multitable', 'write')` from [univer-meta.ts](/private/tmp/metasheet2-record-patch-write-parity-20260406/packages/core-backend/src/routes/univer-meta.ts) for `PATCH /api/multitable/records/:recordId`.
- Reused the existing sheet-scoped capability resolution so callers with sheet `spreadsheet:write` or `spreadsheet:write-own` can enter the route even when they do not hold global `multitable:write`.
- Added the same local authentication gate used by the other write-parity routes:
  - unauthenticated callers return `401`
  - callers without sheet-scoped record edit capability return `403`
- Tightened row-level denial semantics:
  - foreign-row edits under `write-own` now raise `PermissionError`
  - the route returns `403 FORBIDDEN` instead of surfacing row-policy denial as a `400 VALIDATION_ERROR`
- Extended [multitable-sheet-permissions.api.test.ts](/private/tmp/metasheet2-record-patch-write-parity-20260406/packages/core-backend/tests/integration/multitable-sheet-permissions.api.test.ts) to cover:
  - foreign direct patch rejection for `write-own`
  - owned direct patch success without global `multitable:write`
  - the exact SQL shapes used by the direct patch path (`SELECT id, sheet_id ...`, `SELECT ... FOR UPDATE`, and `UPDATE meta_records ... WHERE id = $2 AND sheet_id = $3`)

## Notes
- `spreadsheet:read` remains read-only; this slice does not elevate read grants.
- `write-own` still remains `user-only`; role grants are unaffected.
- Bulk patch parity from [#695](https://github.com/zensgit/metasheet2/pull/695) is unchanged; this slice only closes the remaining direct record edit gap.
