# Multitable Row Actions Write Gating Development

Date: 2026-04-05

## Scope
- Enforce existing `rowActions` in multitable write entrypoints without inventing a new row-level ACL schema.
- Keep the slice frontend-focused because current `main` has no dedicated per-record ACL table or metadata source beyond the already-exposed `rowActions` contract.

## Changes
- Updated [MultitableWorkbench.vue](/private/tmp/metasheet2-row-actions-write-gating-20260405/apps/web/src/multitable/views/MultitableWorkbench.vue) to:
  - pass `effectiveRowActions.canEdit` into kanban and timeline views instead of global `canEditRecord`
  - block direct mutation entrypoints when the current record action is disallowed:
    - grid cell patch
    - timeline date patch
    - drawer patch
    - form update submit
    - link picker confirm
    - record delete
    - bulk delete
  - keep create gating separate via `canCreateRecord`
- Updated [useMultitableGrid.ts](/private/tmp/metasheet2-row-actions-write-gating-20260405/apps/web/src/multitable/composables/useMultitableGrid.ts) to add mutation guards for:
  - `patchCell()`
  - `deleteRecord()`
  - `undo()`
  - `redo()`
- Extended [multitable-workbench-view.spec.ts](/private/tmp/metasheet2-row-actions-write-gating-20260405/apps/web/tests/multitable-workbench-view.spec.ts) to cover:
  - scoped `canEdit` propagation into kanban and timeline views
  - blocked timeline patch when `rowActions.canEdit === false`
  - blocked form update when `rowActions.canEdit === false`
- Extended [multitable-grid.spec.ts](/private/tmp/metasheet2-row-actions-write-gating-20260405/apps/web/tests/multitable-grid.spec.ts) to cover:
  - blocked `patchCell()` when `rowActions.canEdit === false`
  - blocked `deleteRecord()` when `rowActions.canDelete === false`

## Notes
- No backend route changes were added in this slice. Current backend still derives `rowActions` from global multitable write capability, so the real missing gap was frontend mutation enforcement and consistent consumption of the scoped contract already present in responses.
- Local plugin `node_modules` link noise was introduced by `pnpm install` in the clean worktree and was intentionally excluded from the slice.
