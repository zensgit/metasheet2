# Multitable Field And View ACL Governance Development

## Summary
- Built the next stacked slice on top of member-group ACL subjects by making field-level and view-level overrides administratively usable.
- Hydrated field and view permission entries with real subject labels, subtitles, and active-state metadata.
- Changed field-level `Default` back to true override removal instead of persisting an explicit default-shaped row.
- Surfaced orphan field/view overrides when the subject no longer has sheet access, and added direct clear actions for those orphaned overrides.

## Why This Slice
- The member-group ACL subject slice made `platform_member_groups` valid multitable ACL subjects at the API layer.
- Record governance was improved in the previous stacked slice, but field and view governance still had two operational gaps:
  - administrators saw bare subject IDs instead of real labels
  - `Default` kept storing an explicit override rather than clearing it
- There was also no management path for orphan overrides that stayed behind after sheet access changed.

## Runtime Changes

### Backend Permission List Hydration
- Extended `GET /api/multitable/sheets/:sheetId/field-permissions` to join:
  - `users`
  - `roles`
  - `platform_member_groups`
- Extended `GET /api/multitable/views/:viewId/permissions` with the same subject hydration pattern.
- Both endpoints now return:
  - `subjectLabel`
  - `subjectSubtitle`
  - `isActive`
- File:
  - `packages/core-backend/src/routes/univer-meta.ts`

### Frontend Types And Client
- Added hydrated subject metadata to:
  - `MetaFieldPermissionEntry`
  - `MetaViewPermissionEntry`
- Updated client normalization for:
  - field permission list responses
  - view permission list responses
- Widened `updateFieldPermission` so the client can send:
  - `{ remove: true }`
  - or a normal `{ visible, readOnly }` override
- Files:
  - `apps/web/src/multitable/types.ts`
  - `apps/web/src/multitable/api/client.ts`

### MetaSheetPermissionManager Governance Cleanup
- Reworked the field and view tabs in `MetaSheetPermissionManager`:
  - field rows now display hydrated subject labels from permission list payloads
  - view rows now display hydrated subject labels from permission list payloads
  - orphan field overrides now remain visible even if the subject no longer has sheet access
  - orphan view overrides now remain visible even if the subject no longer has sheet access
  - orphan rows expose an explicit `Clear` action
- Added a small hint treatment for orphan rows:
  - `No current sheet access`
- File:
  - `apps/web/src/multitable/components/MetaSheetPermissionManager.vue`

## Governance Semantics

### Field `Default` Means No Override
- Selecting `Default` now removes the field override instead of persisting:
  - `visible: true`
  - `readOnly: false`
- This keeps the data model aligned with operator expectations:
  - default = inherit sheet behavior
  - hidden = explicit override
  - read-only = explicit override

### Orphan Overrides Stay Manageable
- Field/view overrides may outlive the sheet grant that originally made the subject eligible.
- Instead of hiding those rows, the UI now keeps them visible and clearable.
- This avoids a common governance trap where stale overrides remain in the database but become inaccessible to administrators.

## Test Updates
- Frontend:
  - `apps/web/tests/multitable-sheet-permission-manager.spec.ts`
- Backend:
  - `packages/core-backend/tests/integration/multitable-sheet-permissions.api.test.ts`

## Out Of Scope
- No new ACL subject type was introduced in this slice.
- No record ACL behavior change beyond regression coverage.
- No cell-level ACL.
- No deployment or migration changes.
