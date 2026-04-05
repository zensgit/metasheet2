# Multitable Scoped Permissions Import/Export Development

Date: 2026-04-05

## Summary
- narrowed multitable import surfaces to fields that are both visible and writable under the current scoped field permissions
- added a defensive import-modal filter so `property.readonly/readOnly` fields cannot be mapped even if a caller passes them through
- aligned CSV export with the scoped grid field set instead of the raw grid-visible list

## Code Changes
- [MultitableWorkbench.vue](/private/tmp/metasheet2-scoped-permissions-import-export-20260405/apps/web/src/multitable/views/MultitableWorkbench.vue)
  - added `importSurfaceFields`
  - changed `MetaImportModal` to consume the scoped import field set
  - narrowed import link/person resolvers to the same scoped import field set
  - switched CSV export to `scopedGridFields`
- [MetaImportModal.vue](/private/tmp/metasheet2-scoped-permissions-import-export-20260405/apps/web/src/multitable/components/MetaImportModal.vue)
  - added readonly-field filtering for import mapping options
- [multitable-workbench-view.spec.ts](/private/tmp/metasheet2-scoped-permissions-import-export-20260405/apps/web/tests/multitable-workbench-view.spec.ts)
  - updated the existing manager-surface expectation for import
  - added workbench coverage for readonly import filtering
  - added CSV export coverage for scoped visible fields
- [multitable-import-modal.spec.ts](/private/tmp/metasheet2-scoped-permissions-import-export-20260405/apps/web/tests/multitable-import-modal.spec.ts)
  - added a focused readonly import-field regression

## Behavior
- import mapping no longer offers fields that are readonly under the current scoped permissions
- view-hidden fields remain configurable in field/view managers, but no longer appear in the import surface
- CSV export uses the scoped visible grid field list

## Notes
- this slice is frontend-only; no backend or OpenAPI contract changes were required
- `CI=true pnpm install --ignore-scripts` was run in this clean worktree to attach local dependencies; plugin and tools `node_modules` link noise remains unstaged and must not be committed
