# Multitable Scoped Permissions Manager Surfaces Development

## Date
- 2026-04-05

## Goal
- Close the next real scoped-permissions gap after hidden/readOnly enforcement.
- Keep property-hidden fields out of multitable control surfaces without treating `view.hiddenFieldIds` as ACL.

## Scope
- Frontend-only slice on latest `main`.
- No backend contract changes.
- No fake per-view ACL added.

## Changes
- Added [field-permissions.ts](/private/tmp/metasheet2-scoped-permissions-next-20260405/apps/web/src/multitable/utils/field-permissions.ts) with:
  - `isPropertyHiddenField`
  - `filterPropertyVisibleFields`
- Updated [MultitableWorkbench.vue](/private/tmp/metasheet2-scoped-permissions-next-20260405/apps/web/src/multitable/views/MultitableWorkbench.vue):
  - computed `propertyVisibleWorkbenchFields`
  - computed `propertyVisibleGridFields`
  - `MetaFieldManager` now receives only property-visible fields
  - `MetaViewManager` now receives only property-visible fields
  - `MetaToolbar`, `MetaMentionPopover`, and `MetaImportModal` now receive property-visible grid fields
  - dialog metadata refresh now rehydrates `grid.fields` from property-visible workbench fields instead of raw `workbench.fields`
- Updated [useMultitableGrid.ts](/private/tmp/metasheet2-scoped-permissions-next-20260405/apps/web/src/multitable/composables/useMultitableGrid.ts):
  - `visibleFields` now excludes `property.hidden === true` and `property.visible === false` even when `fieldPermissions` is missing
- Updated [multitable-workbench-view.spec.ts](/private/tmp/metasheet2-scoped-permissions-next-20260405/apps/web/tests/multitable-workbench-view.spec.ts):
  - added regression covering toolbar, import modal, field manager, and view manager field lists
  - verifies property-hidden fields are filtered
  - verifies view-hidden fields remain configurable
- Updated [multitable-grid.spec.ts](/private/tmp/metasheet2-scoped-permissions-next-20260405/apps/web/tests/multitable-grid.spec.ts):
  - added regression for property-hidden field exclusion without scoped permission entries

## Non-Goals
- No backend `viewPermissions`/`rowActions` redesign
- No ownership-based view ACL
- No change to `view.hiddenFieldIds` semantics

## Notes
- Claude Code CLI was used as a read-only sidecar to look for edge cases. It did not write code.
