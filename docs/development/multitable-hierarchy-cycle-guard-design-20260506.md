# Multitable Hierarchy Cycle Guard Design - 2026-05-06

## Scope

This slice completes the Phase 7 optional backlog item "Hierarchy server-side cycle prevention".

Implemented:

- A shared backend guard in `packages/core-backend/src/multitable/hierarchy-cycle-guard.ts`.
- Cycle prevention in `RecordWriteService.patchRecords()`, the authoritative batch write seam used by Workbench and Yjs bridge.
- Cycle prevention in `RecordService.patchRecord()`, the legacy single-record PATCH seam used by `/api/multitable/records/:recordId`.
- Field order alignment for hierarchy auto-parent fallback in the REST batch patch route and Yjs bridge write-input builder.

Not implemented:

- Global repair of already-corrupted hierarchy data.
- Multi-parent hierarchy semantics. The guard checks every submitted parent id, but the product hierarchy UI remains a single-parent model.
- Frontend changes. The previous drag-to-reparent slice already added UX guards; this slice is backend authoritative validation.

## Guard Contract

The guard only applies when all conditions are true:

- the changed field is a `link` field
- the link field targets the same sheet (`foreignSheetId === sheetId`)
- at least one hierarchy view exists on the sheet
- the changed link field is the configured `parentFieldId` for that hierarchy view
- if a hierarchy view has no valid `parentFieldId`, the guard uses the first link field by field order, matching `resolveHierarchyViewConfig()` on the frontend

This avoids blocking arbitrary same-sheet relationship fields that are not used as hierarchy parent fields.

## Cycle Detection

For each hierarchy parent update, the backend walks the proposed parent chain:

1. Start from each submitted parent id.
2. If any parent id equals the moving record id, reject.
3. Read the parent record's current parent ids using `SELECT data ... FOR UPDATE`.
4. Continue walking upward until the chain ends, an unrelated existing cycle repeats, or the moving record is reached.

The guard also considers same-request batch overrides from `RecordWriteService.patchRecords()`. That closes cases where a batch update would be acyclic per individual old DB rows but cyclic after applying all submitted parent changes.

## Error Shape

The shared module raises `HierarchyCycleError` with code `HIERARCHY_CYCLE`.

Each service maps it into that service's existing validation error class:

- `RecordWriteService` -> `RecordValidationError(code='HIERARCHY_CYCLE')`
- `RecordService` -> `RecordValidationError(code='HIERARCHY_CYCLE')`

Existing route error mapping then returns a 400 validation response instead of a 500.

## Files

- `packages/core-backend/src/multitable/hierarchy-cycle-guard.ts`
- `packages/core-backend/src/multitable/record-write-service.ts`
- `packages/core-backend/src/multitable/record-service.ts`
- `packages/core-backend/src/routes/univer-meta.ts`
- `packages/core-backend/src/index.ts`
- `packages/core-backend/tests/unit/record-write-service.test.ts`
- `packages/core-backend/tests/unit/record-service.test.ts`

