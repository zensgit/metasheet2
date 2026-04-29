# Wave M-Feishu-3 Hierarchy View Design

Date: 2026-04-29

## Scope

This wave adds the minimum frontend-only hierarchy tree view for multitable records.

- New view type: `hierarchy`.
- New component: `MetaHierarchyView.vue`.
- Configuration keys: `parentFieldId`, `titleFieldId`, `defaultExpandDepth`, `orphanMode`.
- Workbench integration reuses the existing record selection, comments drawer, and `createRecord(initialValues)` path.

## Tree Rules

- `parentFieldId` resolves to an explicit configured link field, or the first link field when omitted.
- Parent extraction uses the first linked record id in the parent field value.
- Rows without a parent are roots.
- Rows with a missing parent are handled on the client:
  - `orphanMode: "root"` shows them at root with a warning.
  - `orphanMode: "hidden"` hides them with a warning.
- Parent cycles are detected client-side and detached to root so the tree cannot recurse forever.
- `titleFieldId` resolves to an explicit field, or the first string/formula/lookup-like field.
- `defaultExpandDepth` controls initial expansion only; users can expand/collapse nodes locally.

## Actions

- Selecting a row emits `select-record` and opens the existing record drawer path in `MultitableWorkbench`.
- Comment buttons emit `open-comments` and reuse the existing comments drawer path.
- `+ Add root` emits an empty create payload.
- `+ Child` emits `{ [parentFieldId]: [parentRecordId] }` when a parent link field is configured.

## Explicit Non-Goals

- No drag-and-drop reparenting in the first version.
- No backend table or schema changes.
- No dedicated hierarchy persistence beyond existing view `config`.
- No cross-sheet or server-side hierarchy materialization.
