# Multitable Workbench Base Rollback And Prop Sync

Date: 2026-03-25

## Context

After the base-scoped workbench bootstrap fix, two user-visible gaps remained in the multitable workbench:

1. Base switch was optimistic in the view layer. If `/api/multitable/context?baseId=...` failed, the base picker could move to the new base while sheet/view data still belonged to the old base.
2. `baseId / sheetId / viewId` props were only consumed during initial mount. If a parent or deep-link updated them after mount, the workbench stayed on the old context.

This round closes both gaps in the clean multitable worktree based on `origin/main`.

## Design

### 1. Move rollback logic into the workbench composable

File:
[useMultitableWorkbench.ts](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/src/multitable/composables/useMultitableWorkbench.ts)

Changes:

- Added snapshot / restore helpers for base, sheet, view, visible sheets, fields, views, and capabilities.
- `loadSheetMeta(...)` now returns `Promise<boolean>` and accepts an optional `viewId`.
- `loadBaseContext(...)` now returns `Promise<boolean>`.
- Added `switchBase(...)`:
  - captures the current workbench snapshot
  - attempts the new base-scoped context load
  - restores the snapshot when the load fails
  - preserves the failure message in `error.value`
- Added `syncExternalContext(...)`:
  - handles post-mount `baseId / sheetId / viewId` changes
  - routes them through `switchBase(...)` or `loadSheetMeta(...)`
  - rolls back on failure

### 2. Suppress redundant sheet-meta reloads during internal state reconciliation

`syncContextState(...)` and snapshot restore now suppress the next `activeSheetId` watch-driven reload for internal context sync transitions.

This avoids two problems:

- duplicate metadata fetches after a controlled base/sheet context switch
- error messages being accidentally cleared by a follow-up watch-triggered reload after rollback

### 3. Keep the view layer thin

File:
[MultitableWorkbench.vue](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/src/multitable/views/MultitableWorkbench.vue)

Changes:

- `onSelectBase(...)` now delegates to `workbench.switchBase(...)`
- added a post-mount watcher for `props.baseId / props.sheetId / props.viewId`
- the watcher calls `workbench.syncExternalContext(...)`
- the view only handles user-facing error toast reporting

This keeps state rollback and context reconciliation in one place instead of duplicating it in the component.

## Tests

### Composable regression

File:
[multitable-workbench.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/tests/multitable-workbench.spec.ts)

Added coverage for:

- base switch failure restores previous base/sheet/view/fields state
- external `baseId / sheetId / viewId` sync loads the requested base-scoped context

### View wiring regression

File:
[multitable-workbench-view.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/apps/web/tests/multitable-workbench-view.spec.ts)

Added coverage for:

- post-mount prop changes call `syncExternalContext(...)`
- failed user base switch surfaces an error toast

## Verification

Executed in:
[metasheet2-multitable-next](/Users/huazhou/Downloads/Github/metasheet2-multitable-next)

Commands:

```bash
pnpm --filter @metasheet/web exec tsc --noEmit --pretty false
pnpm --filter @metasheet/web exec vitest run tests/multitable-workbench.spec.ts tests/multitable-workbench-view.spec.ts --reporter=dot
pnpm --filter @metasheet/web build
```

Results:

- `tsc --noEmit` passed
- `2 files / 14 tests passed`
- `@metasheet/web build` passed

## Out Of Scope

- No attendance files were modified.
- No backend multitable routes changed in this round.
- No smoke / readiness / on-prem scripts were rerun in this round.
