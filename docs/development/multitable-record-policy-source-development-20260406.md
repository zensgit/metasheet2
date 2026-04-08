# Multitable Record Policy Source Development

Date: 2026-04-06

## Goal

Add a real record-level write policy source for multitable instead of relying only on sheet-level capability booleans.

## Scope

- Add `meta_records.created_by` as the owner source for record-level policy.
- Recognize owner-write sheet permission codes:
  - `spreadsheet:write-own`
  - `spreadsheets:write-own`
  - `multitable:write-own`
- Return default `rowActions` plus per-record `rowActionOverrides` from multitable view payloads.
- Return record-specific `rowActions` from record and form contexts.
- Enforce owner-only edit/delete on backend write paths.
- Wire frontend grid and workbench surfaces to consume per-record overrides.

## Runtime Changes

### Backend

- Added `created_by` to the typed `meta_records` table model in `/private/tmp/metasheet2-record-policy-source-20260406/packages/core-backend/src/db/types.ts`.
- Added migration `/private/tmp/metasheet2-record-policy-source-20260406/packages/core-backend/src/db/migrations/zzzz20260406093000_add_meta_record_created_by.ts` to create `meta_records.created_by` and an index on `(sheet_id, created_by)`.
- Extended `/private/tmp/metasheet2-record-policy-source-20260406/packages/core-backend/src/routes/univer-meta.ts` to:
  - summarize `canWriteOwn` from `spreadsheet_permissions.perm_code`
  - derive safe default `rowActions` under owner-write-only scope
  - derive record-specific `rowActions`
  - build `rowActionOverrides` for owned rows in `/api/multitable/view`
  - enforce owner-only edit/delete on:
    - `/api/multitable/views/:viewId/submit`
    - `PATCH /api/multitable/records/:recordId`
    - `DELETE /api/multitable/records/:recordId`
    - `POST /api/multitable/patch`
    - attachment upload/delete against existing records
  - persist `created_by` on record creation paths

### Frontend

- Extended scoped permissions typing in `/private/tmp/metasheet2-record-policy-source-20260406/apps/web/src/multitable/types.ts` with `rowActionOverrides`.
- Updated `/private/tmp/metasheet2-record-policy-source-20260406/apps/web/src/multitable/composables/useMultitableGrid.ts` to:
  - store `rowActionOverrides`
  - resolve row actions per record
  - apply record-scoped gating to edit/delete/undo/redo
- Updated `/private/tmp/metasheet2-record-policy-source-20260406/apps/web/src/multitable/components/MetaGridTable.vue` to:
  - consume `rowActionOverrides`
  - disable selection/delete on non-deletable rows
  - gate cell edit/comment affordances per row
- Updated `/private/tmp/metasheet2-record-policy-source-20260406/apps/web/src/multitable/views/MultitableWorkbench.vue` to:
  - route selected-record actions through per-record row policy
  - respect row overrides for drawer edits, timeline edits, link picker updates, form updates, and bulk delete

## Test Changes

- Extended `/private/tmp/metasheet2-record-policy-source-20260406/packages/core-backend/tests/integration/multitable-sheet-permissions.api.test.ts` with owner-write coverage:
  - default `rowActions` vs `rowActionOverrides`
  - record-specific `rowActions`
  - foreign-row write rejection
- Updated `/private/tmp/metasheet2-record-policy-source-20260406/packages/core-backend/tests/integration/multitable-record-form.api.test.ts` to accept the new `created_by`-aware SQL paths.
- Extended `/private/tmp/metasheet2-record-policy-source-20260406/apps/web/tests/multitable-grid.spec.ts` with row override edit/delete cases.
- Updated `/private/tmp/metasheet2-record-policy-source-20260406/apps/web/tests/multitable-workbench-view.spec.ts` mock grid shape to include `rowActionOverrides` and `resolveRowActions`.

## Notes

- This slice does not introduce a new record ACL table. It deliberately uses `meta_records.created_by` plus sheet permission codes as the first policy source.
- This slice does not yet add richer row policies beyond owner-write semantics.
