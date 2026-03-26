# Multitable Non-Grid Summary Wiring

Date: 2026-03-25
Repo: `/Users/huazhou/Downloads/Github/metasheet2-multitable-next`

## Context

The attachment functional slice was already green in grid, form, and record drawer, but the non-grid views in the clean `multitable-next` worktree still rendered raw IDs or generic counts because they were not consuming `linkSummaries` / `attachmentSummaries`.

That meant:

- Kanban preview fields could fall back to raw linked record IDs.
- Gallery cards could fall back to generic array output instead of attachment filenames.
- Calendar event titles could ignore link/attachment summary display when the title field was not plain string data.
- Timeline labels could still degrade to raw IDs when the label field was a link/attachment-like field.

## Design

### 1. Add a shared display formatter to the new worktree

Added:

- `apps/web/src/multitable/utils/field-display.ts`

It normalizes display for:

- `date`
- `boolean`
- `select`
- `link` with `linkSummaries`
- `attachment` with `attachmentSummaries`
- generic arrays and fallback scalars

This avoids duplicating slightly different display logic across four non-grid views.

### 2. Thread summaries into all non-grid views

Updated:

- `apps/web/src/multitable/components/MetaKanbanView.vue`
- `apps/web/src/multitable/components/MetaGalleryView.vue`
- `apps/web/src/multitable/components/MetaCalendarView.vue`
- `apps/web/src/multitable/components/MetaTimelineView.vue`

Each view now accepts:

- `linkSummaries?: Record<string, Record<string, LinkedRecordSummary[]>>`
- `attachmentSummaries?: Record<string, Record<string, MetaAttachment[]>>`

and uses the shared formatter for:

- card titles
- preview field values
- calendar event titles
- timeline labels

### 3. Wire the workbench shell

Updated:

- `apps/web/src/multitable/views/MultitableWorkbench.vue`

The workbench now passes:

- `grid.linkSummaries.value`
- `grid.attachmentSummaries.value`

into:

- `MetaKanbanView`
- `MetaGalleryView`
- `MetaCalendarView`
- `MetaTimelineView`

This keeps non-grid views consistent with the grid/form/drawer attachment slice that was finished earlier.

## Verification

### Typecheck

Ran:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable-next
pnpm --filter @metasheet/web exec tsc --noEmit --pretty false
```

Result:

- Passed

### Focused regression

Ran:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable-next
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-nongrid-summary-rendering.spec.ts \
  tests/multitable-attachment-editor.spec.ts \
  tests/multitable-form-view.spec.ts \
  tests/multitable-link-picker.spec.ts \
  tests/multitable-workbench.spec.ts \
  tests/multitable-workbench-view.spec.ts \
  tests/multitable-client.spec.ts \
  tests/utils/api.test.ts \
  --reporter=dot
```

Result:

- `8 files / 43 tests passed`

New focused coverage:

- `tests/multitable-nongrid-summary-rendering.spec.ts`
  - kanban renders link summary display instead of raw ID
  - gallery renders attachment filename instead of raw attachment ID
  - calendar event title resolves summary-backed label
  - timeline label resolves summary-backed label

### Build

Ran:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable-next
pnpm --filter @metasheet/web build
```

Result:

- Passed
- only existing Vite large chunk warnings remained

## Notes

- This round stayed entirely on the frontend side; no backend files changed.
- The old multitable worktree is still worth keeping for now. Non-grid summary wiring is now migrated, but there are still additional old-branch slices worth selectively porting before deleting it.
