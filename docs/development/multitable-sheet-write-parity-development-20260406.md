# Multitable Sheet Write Parity Development

## Scope
- Extend sheet-level ACL write grants from read surfaces into the core record mutation routes:
  - `/api/multitable/records`
  - `/api/multitable/views/:viewId/submit`
  - `/api/multitable/patch`
  - `/api/multitable/records/:recordId` (delete)
- Keep the slice scoped to record mutations. No field/view/schema management and no attachment upload/delete parity in this step.

## Changes
- Added `applyContextSheetRecordWriteGrant()` in [univer-meta.ts](/private/tmp/metasheet2-sheet-write-parity-20260406/packages/core-backend/src/routes/univer-meta.ts) to layer record-write capabilities on top of the existing sheet-readable scope when the caller has `spreadsheet:write` or `spreadsheet:write-own`.
- Updated `resolveSheetCapabilities()`, `resolveSheetReadableCapabilities()`, and the `/api/multitable/context` effective-sheet capability path to use the new helper so write-capable shared users receive record mutation capabilities without also gaining field/view management.
- Removed `rbacGuard('multitable', 'write')` from the four target record mutation routes and replaced it with route-local access checks:
  - return `401` when `access.userId` is missing
  - continue returning `403` when the sheet-scoped policy does not allow the requested mutation
- Preserved row-level semantics for `write-own`:
  - default `rowActions` remain off for non-owned rows
  - `buildRowActionOverrides()` still re-enables edit/delete only for owned rows
  - foreign row delete remains forbidden
- Extended integration coverage in [multitable-sheet-permissions.api.test.ts](/private/tmp/metasheet2-sheet-write-parity-20260406/packages/core-backend/tests/integration/multitable-sheet-permissions.api.test.ts) to prove that a user with no global `multitable:write` but with sheet `write-own` can:
  - create a record
  - submit a form-backed record
  - patch an owned record
  - delete an owned record
  while still being blocked from deleting a foreign record.

## Notes
- `spreadsheet:read` remains read-only; this slice does not elevate read grants into write capabilities.
- `spreadsheet:write-own` is still `user-only`; role grants keep rejecting `write-own`.
- Attachment upload/delete, field/view management, and sheet authoring remain governed by their existing ACL paths and are intentionally out of scope here.
