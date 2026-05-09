# Multitable Hierarchy Drag Reparent Design - 2026-05-06

## Scope

This slice implements the Phase 7 optional backlog item "Hierarchy drag-to-reparent" as a frontend-to-authoritative-write integration.

Implemented:

- `MetaHierarchyView` rows become draggable when the current row scope allows editing.
- Dropping a row onto another hierarchy row emits a reparent payload with `recordId`, `version`, `parentFieldId`, and `parentRecordId`.
- Dropping a row onto the root drop zone clears the parent link.
- `MultitableWorkbench` handles `reparent-record` by calling `workbench.client.patchRecords()` with `expectedVersion`.
- The active grid page reloads after a successful write, and the selected deep-link record is refreshed when needed.
- Client-side guards reject no-op moves, self-parenting, and moving a record under one of its descendants.

Not implemented in this slice:

- Server-side cycle prevention. The next backlog item remains necessary because other callers can still patch the parent link field directly.
- Multi-record drag operations.
- Custom drag preview styling.

## Write Path

The hierarchy component stays presentation-focused and does not import the API client. It emits:

```ts
{
  recordId: string
  version: number
  parentFieldId: string
  parentRecordId: string | null
}
```

`MultitableWorkbench` converts that payload to the existing record patch seam:

```ts
await workbench.client.patchRecords({
  sheetId,
  viewId,
  changes: [
    {
      recordId,
      fieldId: parentFieldId,
      value: parentRecordId ? [parentRecordId] : [],
      expectedVersion: version,
    },
  ],
})
```

This keeps version conflict behavior, field validation, realtime invalidation, and backend write semantics on the same path used by grid/timeline/gantt edits.

## Permissions

`MultitableWorkbench` passes `effectiveRowActions.canEdit` into `MetaHierarchyView`. The component only enables drag affordances when `canEdit` is true, and the workbench handler still calls `ensureCanEditRecord(recordId)` before writing.

This mirrors the existing timeline/gantt edit gating pattern and avoids relying on UI affordances as the only permission boundary.

## Cycle Guard

The component builds a parent-to-children index from the current page rows and rejects:

- moving a record under itself
- moving a record under one of its visible descendants

This is intentionally a UX guard only. It catches common mistakes before the patch request but is not authoritative because the current page may not contain the full hierarchy and other clients can patch the parent field directly.

## Files

- `apps/web/src/multitable/components/MetaHierarchyView.vue`
- `apps/web/src/multitable/views/MultitableWorkbench.vue`
- `apps/web/tests/multitable-hierarchy-view.spec.ts`
- `apps/web/tests/multitable-workbench-view.spec.ts`

