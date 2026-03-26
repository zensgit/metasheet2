# Multitable Non-Grid View Config Port

Date: 2026-03-25
Workspace: `/Users/huazhou/Downloads/Github/metasheet2-multitable-next`

## Goal

Port the high-value non-grid `view-config` slice from the old multitable worktree into the clean `origin/main`-based worktree so that:

- `gallery`, `kanban`, `calendar`, and `timeline` can read persisted view config.
- Inline config changes emit stable `update-view-config` payloads.
- `timeline` can emit `patch-dates` and the workbench can persist those changes.
- The workbench can persist non-grid view config through the existing `/api/multitable/views/:viewId` contract instead of keeping these views as display-only shells.

## Problem

Before this round, `multitable-next` already had:

- summary-aware non-grid rendering
- attachment/link summaries wired into non-grid views
- a restored `/api/multitable` backend runtime contract

But it was still missing the view-config layer:

- `MetaView.config` was absent from frontend types.
- `MultitableWorkbench.vue` did not pass `view-config`, `group-info`, or `@update-view-config` into non-grid views.
- `timeline` had no workbench-side `patch-dates` persistence.
- the four non-grid components in the clean worktree were still much thinner than the old, already-validated implementations.

This meant the current branch rendered non-grid views, but did not preserve richer view behavior or let users tune those views inline.

## Design

### 1. Restore the view-config contract

Updated `/apps/web/src/multitable/types.ts` to add:

- `MetaView.config`
- `CreateViewInput.config`
- `UpdateViewInput.config`
- `MetaGalleryViewConfig`
- `MetaCalendarViewConfig`
- `MetaKanbanViewConfig`
- `MetaTimelineViewConfig`

Added `/apps/web/src/multitable/utils/view-config.ts` with normalized config resolvers for all four non-grid views.

### 2. Reconnect workbench non-grid persistence

Updated `/apps/web/src/multitable/views/MultitableWorkbench.vue` to:

- pass `view-config` into `MetaGalleryView`, `MetaKanbanView`, `MetaCalendarView`, and `MetaTimelineView`
- pass `group-info` into `MetaKanbanView`
- listen for `@update-view-config`
- listen for `@patch-dates` from `MetaTimelineView`
- persist active view config through `onPersistActiveViewConfig(...)`
- unify view updates through `updateViewInternal(...)`

### 3. Port richer non-grid component behavior

Replaced the simplified clean-worktree implementations with the richer old-worktree behavior for:

- `/apps/web/src/multitable/components/MetaGalleryView.vue`
- `/apps/web/src/multitable/components/MetaKanbanView.vue`
- `/apps/web/src/multitable/components/MetaCalendarView.vue`
- `/apps/web/src/multitable/components/MetaTimelineView.vue`

The port intentionally preserved the new worktree’s already-restored summary display behavior by keeping `formatFieldDisplay(...)` + link/attachment summaries in place.

### 4. Lock behavior with focused regression coverage

Added focused component/workbench specs for:

- persisted gallery config rendering and inline gallery config updates
- persisted kanban config rendering and inline kanban config updates
- persisted calendar mode/config behavior and quick-create payloads
- persisted timeline config behavior, `update-view-config`, and `patch-dates`
- workbench-side persistence for gallery config and timeline date patching

## Verification

Commands run:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable-next
pnpm --filter @metasheet/web exec tsc --noEmit --pretty false
node --check /Users/huazhou/Downloads/Github/metasheet2-multitable-next/scripts/verify-smoke-core.mjs
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-gallery-view.spec.ts \
  tests/multitable-kanban-view.spec.ts \
  tests/multitable-calendar-view.spec.ts \
  tests/multitable-timeline-view.spec.ts \
  tests/multitable-nongrid-summary-rendering.spec.ts \
  tests/multitable-workbench.spec.ts \
  tests/multitable-workbench-view.spec.ts \
  --reporter=dot
pnpm --filter @metasheet/web build
```

Results:

- `tsc --noEmit`: passed
- `node --check scripts/verify-smoke-core.mjs`: passed
- focused frontend Vitest: `7 files / 30 tests passed`
- frontend build: passed

## Files

Primary implementation:

- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/src/multitable/types.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/src/multitable/utils/view-config.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/src/multitable/views/MultitableWorkbench.vue`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/src/multitable/components/MetaGalleryView.vue`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/src/multitable/components/MetaKanbanView.vue`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/src/multitable/components/MetaCalendarView.vue`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/src/multitable/components/MetaTimelineView.vue`

Primary tests:

- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/tests/multitable-gallery-view.spec.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/tests/multitable-kanban-view.spec.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/tests/multitable-calendar-view.spec.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/tests/multitable-timeline-view.spec.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/tests/multitable-nongrid-summary-rendering.spec.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/tests/multitable-workbench-view.spec.ts`

## Remaining Follow-Up

This round restored the non-grid config layer and workbench persistence, but it still did not:

- lift the richer `MetaViewManager` config editor back into `multitable-next`
- wire the restored non-grid config behavior into a full live smoke flow
- migrate the rest of the old worktree’s attachment/UI polish beyond the slices already ported

The next most valuable step is to port the richer `MetaViewManager` config UI so users can tune non-grid views from both the view surface and the manager dialog.
