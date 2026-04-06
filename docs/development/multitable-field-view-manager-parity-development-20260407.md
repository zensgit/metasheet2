# Multitable Field/View Manager Parity Development

## Date
- 2026-04-07

## Scope
- Allow direct sheet `spreadsheet:write` grants to manage multitable fields and views without requiring global `multitable:write`.
- Keep `spreadsheet:write-own` limited to record-level actions.
- Keep sheet sharing, base management, and sheet create/delete outside this slice.

## Runtime Changes
- Added `applyContextSheetSchemaWriteGrant()` in [packages/core-backend/src/routes/univer-meta.ts](/private/tmp/metasheet2-field-view-manager-parity-20260407/packages/core-backend/src/routes/univer-meta.ts).
- Updated `resolveSheetCapabilities()` and the `/api/multitable/context` path to elevate:
  - `canManageFields`
  - `canManageViews`
  when the effective sheet scope is direct or role-derived `write`.
- Removed route-level global multitable guards from:
  - `GET /api/multitable/fields`
  - `POST /api/multitable/fields`
  - `PATCH /api/multitable/fields/:fieldId`
  - `DELETE /api/multitable/fields/:fieldId`
  - `POST /api/multitable/person-fields/prepare`
  - `GET /api/multitable/views`
  - `POST /api/multitable/views`
  - `PATCH /api/multitable/views/:viewId`
  - `DELETE /api/multitable/views/:viewId`
- These routes now rely on the existing sheet-scoped capability checks inside the handlers.

## Test Coverage
- Extended [packages/core-backend/tests/integration/multitable-sheet-permissions.api.test.ts](/private/tmp/metasheet2-field-view-manager-parity-20260407/packages/core-backend/tests/integration/multitable-sheet-permissions.api.test.ts) with:
  - read-only direct grant field/view list parity without global multitable permission
  - direct sheet `write` field/view manager parity without global multitable permission
  - updated expectations for the existing `share + sheet write` authoring test after schema parity elevation

## Explicit Non-Goals
- No changes to sheet permission authoring requirements.
- No changes to base creation, sheet creation, or sheet deletion.
- No changes to automation capability elevation.
