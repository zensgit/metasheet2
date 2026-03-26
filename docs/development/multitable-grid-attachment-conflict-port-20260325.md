# Multitable Grid Attachment + Conflict Recovery Port

## Goal

Finish the last two still-useful functional slices from the old multitable worktree:

- grid inline attachment maintenance
- workbench/grid conflict recovery UI for `VERSION_CONFLICT`

## Why These Two

A targeted old-vs-new scan showed that most higher-value manager/import/runtime slices were already ported into the clean mainline worktree. The remaining user-visible gaps were:

1. grid attachment editing only supported upload, not remove / clear
2. grid/workbench no longer surfaced a first-class recovery flow for optimistic edit conflicts

These are both operationally important and worth keeping.

## Design

### 1. Restore grid attachment maintenance

`MetaCellEditor` now restores the richer attachment editor path:

- render current attachment list
- remove a single attachment
- clear all attachments
- validate file selection before upload
- show upload / remove / clear activity and errors

`MetaGridTable` and `MultitableWorkbench` now pass through:

- `deleteAttachmentFn`
- `attachmentSummaries`

Behavior split:

- when `deleteAttachmentFn` is available, attachment removal/clear uses it directly and only updates local editor state
- when `deleteAttachmentFn` is absent, the editor falls back to emitting a patched attachment-id array

That avoids redundant `patch-cell` writes after a backend-backed attachment deletion.

### 2. Restore conflict recovery flow

`useMultitableGrid` now restores:

- `conflict`
- `reloadCurrentPage()`
- `dismissConflict()`
- `retryConflict()`

`patchCell(...)` once again converts `VERSION_CONFLICT` responses into a structured client-side pending conflict state instead of only surfacing a raw error string.

`MultitableWorkbench` now renders a conflict banner with:

- `Reload latest`
- `Retry change`
- `Dismiss`

and success feedback for reload/retry completion.

## Verification

Commands run:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable-next
pnpm --filter @metasheet/web exec tsc --noEmit --pretty false
pnpm --filter @metasheet/web exec vitest run tests/multitable-attachment-editor.spec.ts tests/multitable-grid-attachment-editor.spec.ts tests/multitable-grid.spec.ts tests/multitable-workbench-view.spec.ts tests/multitable-workbench-manager-flow.spec.ts tests/multitable-workbench-import-flow.spec.ts --reporter=dot
pnpm --filter @metasheet/web exec vitest run tests/multitable-client.spec.ts tests/multitable-import.spec.ts tests/multitable-import-modal.spec.ts tests/multitable-people-import.spec.ts tests/multitable-link-picker.spec.ts tests/multitable-workbench-import-flow.spec.ts tests/multitable-workbench-view.spec.ts tests/multitable-field-manager.spec.ts tests/multitable-form-view.spec.ts tests/multitable-attachment-editor.spec.ts tests/multitable-grid-attachment-editor.spec.ts tests/multitable-grid.spec.ts tests/multitable-workbench-manager-flow.spec.ts --reporter=dot
pnpm --filter @metasheet/web build
```

Results:

- `tsc --noEmit`: passed
- grid/workbench focused regressions: `6 files / 49 tests passed`
- expanded multitable focused regressions: passed
- `@metasheet/web build`: passed

## Result

After this port, the clean mainline worktree now has the two remaining old-worktree functional slices that were still worth carrying forward:

- inline grid attachment maintenance
- first-class conflict recovery UX

The old worktree still should not be deleted yet if we want full historical confidence, but the remaining functional delta is now much smaller and mostly no longer on the main multitable user path.
