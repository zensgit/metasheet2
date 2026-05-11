# Multitable Bulk Edit Partial Success - Development - 2026-05-10

## Status

Implemented on branch `codex/multitable-bulk-edit-partial-success-20260510`.

This slice follows PR #1451. PR #1451 added the user-facing bulk Set/Clear dialog and reserved a frontend return shape:

```ts
{ updated: string[]; failed: Array<{ recordId: string; reason: string }> }
```

Before this slice, the backend `/api/multitable/patch` route still executed all changes in one `RecordWriteService.patchRecords()` call. A single row-level version conflict rejected the whole request and left the reserved `failed[]` shape unused.

## Design

The implementation is opt-in and preserves existing all-or-nothing behavior by default.

- `POST /api/multitable/patch` accepts `partialSuccess?: boolean`.
- If `partialSuccess` is absent or false, the route calls `RecordWriteService.patchRecords()` once with the full `changesByRecord` map, exactly as before.
- If `partialSuccess` is true, the route iterates records and calls `RecordWriteService.patchRecords()` once per record, each in the existing service transaction boundary.
- Known per-row failures are serialized into `data.failed[]` instead of aborting successful rows.
- Unknown/internal failures are not swallowed; they still propagate to the existing 500 path.

## Failure Shape

```ts
type PatchFailurePayload = {
  recordId: string
  code: string
  message: string
  serverVersion?: number
}
```

Serialized per-row failures:

- `CONFLICT`
- `VERSION_CONFLICT`
- `NOT_FOUND`
- `FIELD_READONLY` and other service field-forbidden codes
- `VALIDATION_ERROR` and service validation codes such as `HIERARCHY_CYCLE`

## Frontend Behavior

`useMultitableGrid.bulkPatch()` now sends:

```ts
partialSuccess: true
```

It applies successful row updates through the existing `applyPatchResult()` path, then maps backend `failed[]` into the reserved frontend shape:

```ts
{ recordId, reason }
```

`MultitableWorkbench` now shows both sides of a partial result:

- Success toast for the records actually updated.
- Dialog error with a compact failure summary for failed rows.
- Dialog remains open when any rows fail, so the user can inspect the failure and retry after reload or correction.

## Files Changed

- `packages/core-backend/src/routes/univer-meta.ts`
- `packages/core-backend/tests/integration/multitable-patch-partial-success.api.test.ts`
- `apps/web/src/multitable/types.ts`
- `apps/web/src/multitable/composables/useMultitableGrid.ts`
- `apps/web/src/multitable/views/MultitableWorkbench.vue`
- `apps/web/tests/multitable-grid.spec.ts`

## Non-Goals

- No change to single-cell edit, undo, redo, timeline, gantt, or hierarchy patch callers; they keep all-or-nothing semantics.
- No new database migration.
- No OpenAPI schema update in this slice; this is an internal client-route contract extension under the existing multitable patch endpoint.
- No live PostgreSQL performance claim. The route-level test mocks `RecordWriteService` to lock behavior without requiring DB provisioning.
