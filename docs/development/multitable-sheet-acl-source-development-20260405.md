# Multitable Sheet ACL Source Development

## Summary
- Added a real `spreadsheet_permissions` migration and DB typing so multitable can narrow scoped ACL from per-sheet permission assignments instead of only global token capabilities.
- Wired sheet-scoped ACL enforcement into multitable context, record, form, field, view, sheet, attachment, summary, link-option, create, patch, delete, and form-submit routes.
- Kept backward compatibility for partially migrated environments by treating an undefined `spreadsheet_permissions` table as "no sheet assignments", which falls back to the current global capability model.

## Runtime Changes
- Added migration:
  - `packages/core-backend/src/db/migrations/zzzz20260405190000_create_spreadsheet_permissions.ts`
- Added DB typing:
  - `packages/core-backend/src/db/types.ts`
- Added sheet ACL helpers and enforcement:
  - `packages/core-backend/src/routes/univer-meta.ts`

## ACL Semantics
- Admin role bypasses sheet-scoped narrowing.
- If a user has no `spreadsheet_permissions` rows for a sheet, multitable keeps the current global capability behavior.
- If a user has sheet assignments:
  - `spreadsheet:read`, `spreadsheet:write`, `spreadsheets:read`, `spreadsheets:write`, `multitable:read`, `multitable:write` grant sheet read.
  - `spreadsheet:write`, `spreadsheets:write`, `multitable:write` grant sheet write.
- Scoped sheet read narrows:
  - `canRead`
  - `canComment`
- Scoped sheet write narrows:
  - `canCreateRecord`
  - `canEditRecord`
  - `canDeleteRecord`
  - `canManageFields`
  - `canManageViews`
  - `canManageAutomation`

## Enforcement Coverage
- Read surfaces:
  - `/api/multitable/context`
  - `/api/multitable/view`
  - `/api/multitable/form-context`
  - `/api/multitable/records/:recordId`
  - `/api/multitable/records-summary`
  - `/api/multitable/fields/:fieldId/link-options`
  - attachment download
- Write and management surfaces:
  - `/api/multitable/views/:viewId/submit`
  - attachment upload/delete
  - record create/update/delete
  - bulk patch
  - field create/update/delete
  - person field preset preparation
  - view create/update/delete
  - sheet delete

## Test Updates
- Added focused ACL coverage:
  - `packages/core-backend/tests/integration/multitable-sheet-permissions.api.test.ts`
- Updated existing mock-based integration tests so new `spreadsheet_permissions` lookups default to empty rows instead of failing as unhandled SQL:
  - `packages/core-backend/tests/integration/multitable-context.api.test.ts`
  - `packages/core-backend/tests/integration/multitable-record-form.api.test.ts`

## Notes
- `DELETE /records/:recordId` originally attempted to return `sendForbidden(res)` inside the transaction callback. That was corrected so ACL is checked before entering the transactional delete path.
- `GET /api/multitable/views` still creates a default view when none exist, but now only when the caller has `canManageViews`; read-only callers no longer trigger an implicit write.
