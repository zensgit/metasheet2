# Multitable Dialog Metadata Refresh

Date: 2026-03-25

## Goal

Restore live `loadSheetMeta(...)` refresh while multitable dialogs are open in the clean mainline worktree, so stale-draft protection in field/view/import flows can see upstream metadata changes without requiring a remount.

## Problem

After the manager config persistence slice, the clean worktree still had a remaining gap compared with the older multitable branch:

- `MetaFieldManager`, `MetaViewManager`, and `MetaImportModal` no longer kept sheet metadata fresh while they stayed open.

That left two user-visible risks:

1. long-lived dialogs could keep editing stale field/view metadata
2. switching to another sheet while a dialog refresh was already in flight could delay the next refresh until the 1.2s interval tick

The old worktree already had a basic polling loop, but it did not explicitly handle the "sheet changed during an in-flight refresh" case.

## Design

### 1. Restore dialog-scoped metadata polling

File:
[MultitableWorkbench.vue](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/src/multitable/views/MultitableWorkbench.vue)

The workbench now starts a silent metadata refresh loop when any of these are open:

- field manager
- view manager
- import modal

Behavior:

- immediate `loadSheetMeta(...)` on open
- repeat every `1200ms` while still open
- stop immediately when all tracked dialogs are closed
- stop on unmount

Refresh failures stay silent here; explicit save/import actions still surface their own errors.

### 2. Queue an immediate follow-up refresh when sheet context changes mid-flight

The restored loop adds one safety layer beyond the old worktree:

- if `activeSheetId` changes while a metadata refresh is already running, the next refresh is queued immediately
- as soon as the in-flight refresh resolves, the workbench re-runs `loadSheetMeta(...)` for the latest active sheet instead of waiting for the next interval tick

This avoids a short but real stale window after base/sheet switching.

### 3. Cover open, close, and mid-flight sheet-switch behavior

File:
[multitable-workbench-view.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/tests/multitable-workbench-view.spec.ts)

Added focused regressions for:

- immediate + interval metadata refresh while the view manager is open
- timer shutdown after the manager closes
- immediate follow-up refresh when the active sheet changes during an in-flight refresh

## Files Changed

- [MultitableWorkbench.vue](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/src/multitable/views/MultitableWorkbench.vue)
- [multitable-workbench-view.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/tests/multitable-workbench-view.spec.ts)

## Verification

Executed in:
[metasheet2-multitable-next](/Users/huazhou/Downloads/Github/metasheet2-multitable-next)

### Frontend typecheck

```bash
pnpm --filter @metasheet/web exec tsc --noEmit --pretty false
```

Result: passed

### Focused frontend regressions

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-workbench-view.spec.ts \
  tests/multitable-workbench-manager-flow.spec.ts \
  tests/multitable-view-manager.spec.ts \
  --reporter=dot
```

Result:

- `3 files / 18 tests passed`

### Frontend build

```bash
pnpm --filter @metasheet/web build
```

Result: passed

Observed warning:

- Vite large chunk warning remains, but this slice did not materially change bundle structure

## Outcome

The clean multitable mainline now matches and slightly exceeds the old branch behavior for manager-side metadata freshness:

- dialogs refresh metadata live while open
- refresh polling stops cleanly on close/unmount
- sheet switches during an in-flight refresh no longer wait for the next polling tick

## Next

Recommended next slice:

1. Extend the same stale-metadata protection to manager open-state UX by surfacing a subtle "metadata refreshed" / drift cue when upstream fields/views changed while a dialog stayed open.
2. Keep selectively porting only high-value old-worktree polish that is backed by focused regression coverage.
