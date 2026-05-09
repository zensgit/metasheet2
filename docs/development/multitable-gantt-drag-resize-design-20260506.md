# Multitable Gantt Drag Resize Design - 2026-05-06

## Scope

This slice adds interactive start/end resizing to the built-in multitable Gantt view. It is a frontend integration over the existing authoritative `patchRecords` write path and does not add backend routes, migrations, or new record semantics.

## Goals

- Show resize handles on Gantt task bars when the current row is editable.
- Let users drag the left edge to update the start field and the right edge to update the end field.
- Persist the resized dates through the same `patch-dates` payload shape already used by Timeline.
- Reuse the existing `RecordWriteService` backed `patchRecords` path from `MultitableWorkbench`.
- Keep read-only users from seeing resize handles or emitting writes.

## Interaction Model

- Resize is enabled only when:
  - `canEdit` is true.
  - both `startFieldId` and `endFieldId` are configured.
  - start and end use different fields.
- Each bar renders two edge handles with accessible separator labels.
- Dragging updates an in-component preview for the active bar.
- Releasing the mouse emits:

```ts
{
  recordId: string
  version: number
  startFieldId: string
  endFieldId: string
  startValue: string
  endValue: string
}
```

`MultitableWorkbench` wires this to the same handler as Timeline, which sends two expected-version guarded changes through `patchRecords`.

## Date Semantics

- The Gantt view remains day-granularity.
- Resized values are emitted as ISO `YYYY-MM-DD` strings.
- Date conversion uses UTC ISO slicing to avoid local-time off-by-one regressions.
- The Gantt axis now keeps at least one day of visual padding around the scheduled range so edge resizing has usable space even for short tasks.

## Non-Goals

- No whole-bar drag/move operation.
- No dependency-aware auto-shifting.
- No server-side scheduling model.
- No multi-record batch resize.
- No keyboard resize control in this slice.

## Risk Controls

- Resize handles are hidden for read-only rows.
- The component does not emit if the final date range is unchanged.
- The workbench still gates writes through `ensureCanEditRecord()`.
- Existing optimistic conflict behavior is preserved through `expectedVersion`.
