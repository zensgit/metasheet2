# Multitable View Manager Config Port

Date: 2026-03-25

## Goal

Port the richer `MetaViewManager` configuration flow from the old multitable worktree into the clean mainline worktree so that view-level configuration is no longer split between:

- direct non-grid interactions inside each view, and
- a stripped-down manager that can only rename/create/delete views.

This round focuses on restoring the manager-side contract for:

- `gallery`
- `calendar`
- `timeline`
- `kanban`

and on restoring the stale-draft / reload-latest protections that existed in the old worktree.

## Problem

The clean worktree still had a minimal `MetaViewManager`:

- no `Configure` action
- no `fields` input
- no per-view config editors
- no stale warning
- no `Reload latest`
- no discard guard when switching config targets

That left a real behavioral gap versus the reference line:

- manager-driven view configuration was missing
- upstream `views` / `fields` changes could silently desync manager drafts
- workbench already supported `update-view { config?, groupInfo? }`, but the manager could not emit it

## Design

### 1. Restore manager-side config editors

`MetaViewManager.vue` now restores the old manager-side configuration surfaces:

- `gallery`: title field, cover field, card fields, columns, card size
- `calendar`: date field, end date field, title field, week start
- `timeline`: start field, end field, label field, zoom
- `kanban`: group field, card fields

It uses the already-ported shared helpers in `utils/view-config.ts`, so this round did not duplicate config normalization logic.

### 2. Keep manager and workbench contracts aligned

`MultitableWorkbench.vue` now passes `fields` into `MetaViewManager`, which is required for:

- config hydration
- config validation
- stale-draft blocking
- `kanban` group field emission through `groupInfo`

No backend or API contract changes were needed because workbench already supports:

- `onUpdateView(viewId, { name?, config?, groupInfo? })`

### 3. Restore stale-draft and reload-latest behavior

The port keeps the old manager protection model:

- clean drafts rehydrate automatically when `views` or `fields` props change
- dirty drafts are marked outdated instead of silently overwritten
- invalid upstream field/type changes block save until `Reload latest`
- removing the configured view closes the config panel and clears warning state

### 4. Restore discard guards for manager UX

The port also restores discard confirmation when:

- closing the manager with unsaved drafts
- switching config target while current config draft is dirty
- switching rename target while the current rename draft is dirty

## Files Changed

- `apps/web/src/multitable/components/MetaViewManager.vue`
- `apps/web/src/multitable/views/MultitableWorkbench.vue`
- `apps/web/tests/multitable-view-manager.spec.ts`

## Verification

### Typecheck

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable-next
pnpm --filter @metasheet/web exec tsc --noEmit --pretty false
```

Result: passed

### Focused manager / non-grid regressions

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable-next
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-view-manager.spec.ts \
  tests/multitable-gallery-view.spec.ts \
  tests/multitable-kanban-view.spec.ts \
  tests/multitable-calendar-view.spec.ts \
  tests/multitable-timeline-view.spec.ts \
  tests/multitable-workbench-view.spec.ts \
  --reporter=dot
```

Result:

- `6 files / 20 tests passed`

New manager-focused coverage includes:

- persisted `timeline` config save
- stale-draft reconciliation and `Reload latest`
- dirty config-target switch guard
- disappearing configured view cleanup
- upstream field rename reconciliation while clean
- save blocking when selected config fields become invalid upstream

### Workbench regression

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable-next
pnpm --filter @metasheet/web exec vitest run tests/multitable-workbench.spec.ts --reporter=dot
```

Result:

- `1 file / 12 tests passed`

### Build

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable-next
pnpm --filter @metasheet/web build
```

Result: passed

## Outcome

The clean multitable mainline now has manager-side view configuration parity for the main non-grid view types, plus the higher-value stale-draft and guard behavior from the reference line.

This round intentionally stopped short of migrating the richer `MetaViewManager`-adjacent view-creation presets and any new smoke/runtime coverage. The workbench/runtime contract already supports the restored manager flow, so the remaining value is now mostly in:

- higher-level smoke coverage for manager config persistence
- any remaining richer view-manager presets or polish from the old worktree

## Next

Recommended next slice:

1. Add higher-level smoke for manager-driven non-grid config persistence.
2. Continue selectively porting any remaining richer `MetaViewManager` presets from the old worktree.
