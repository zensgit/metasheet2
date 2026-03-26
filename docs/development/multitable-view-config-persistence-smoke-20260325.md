# Multitable View Config Persistence Smoke

Date: 2026-03-25

## Goal

Raise the restored non-grid `MetaViewManager` flow above component-only coverage so the clean multitable mainline has:

- a real `MultitableWorkbench + MetaViewManager` integration smoke
- backend integration coverage for `create view / update view config`
- API smoke script checks for view-config persistence

This closes the gap where manager-side config had been restored functionally, but was still only protected by focused manager component tests.

## Problem

After the `MetaViewManager` config port, the clean worktree still had two remaining coverage holes:

1. No higher-level smoke proving that the real workbench wiring persists manager-driven non-grid config changes through `client.updateView(...)`.
2. No smoke or backend integration proving that `/api/multitable/views` and `/api/multitable/views/:viewId` actually persist `config` / `groupInfo`.

That left a realistic failure mode:

- manager UI could look correct
- workbench wiring could drift
- backend persistence could drift
- and the existing smoke report would still stay green

## Design

### 1. Add a real workbench-manager integration smoke

New frontend smoke:

- `apps/web/tests/multitable-workbench-manager-flow.spec.ts`

This mounts the real `MultitableWorkbench` with the real `MetaViewManager`, opens the manager through the actual `Views` button, edits a `timeline` config, saves it, and verifies:

- `client.updateView(...)`
- `loadSheetMeta(...)`
- `grid.loadViewData(...)`
- success toast

This deliberately tests the real manager-to-workbench persistence path instead of only the manager component in isolation.

### 2. Expand manager guard/recovery coverage

`apps/web/tests/multitable-view-manager.spec.ts` now also covers:

- close confirmation with unsaved drafts
- rename-target discard guard
- new-view draft reset after close/reopen

These were still part of the restored behavior, but were not yet covered in the clean worktree.

### 3. Extend backend integration to view-config persistence

New backend integration:

- `packages/core-backend/tests/integration/multitable-view-config.api.test.ts`

It verifies:

- `POST /api/multitable/views` persists `config`
- `PATCH /api/multitable/views/:viewId` persists both `config` and `groupInfo`

This keeps the workbench/manager contract backed by direct API-level persistence checks.

### 4. Extend API smoke script

`scripts/verify-smoke-core.mjs` now checks:

- `api.multitable.create-view`
- `api.multitable.update-view-config`
- `api.multitable.view-config-persisted`

The smoke flow now creates a gallery view, patches its config, then re-reads views to confirm persistence instead of only checking list/context/fields existence.

## Files Changed

- `apps/web/tests/multitable-workbench-manager-flow.spec.ts`
- `apps/web/tests/multitable-view-manager.spec.ts`
- `packages/core-backend/tests/integration/multitable-view-config.api.test.ts`
- `scripts/verify-smoke-core.mjs`

## Verification

### Frontend typecheck

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable-next
pnpm --filter @metasheet/web exec tsc --noEmit --pretty false
```

Result: passed

### Backend typecheck

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable-next
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
```

Result: passed

### Smoke script syntax

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable-next
node --check scripts/verify-smoke-core.mjs
```

Result: passed

### Focused frontend regressions

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable-next
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-workbench-manager-flow.spec.ts \
  tests/multitable-view-manager.spec.ts \
  tests/multitable-workbench-view.spec.ts \
  tests/multitable-gallery-view.spec.ts \
  tests/multitable-kanban-view.spec.ts \
  tests/multitable-calendar-view.spec.ts \
  tests/multitable-timeline-view.spec.ts \
  --reporter=dot
```

Result:

- `7 files / 24 tests passed`

### Backend targeted integration

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable-next/packages/core-backend
pnpm exec vitest --config vitest.integration.config.ts run \
  tests/integration/multitable-context.api.test.ts \
  tests/integration/multitable-record-form.api.test.ts \
  tests/integration/multitable-attachments.api.test.ts \
  tests/integration/multitable-view-config.api.test.ts \
  --reporter=dot
```

Result:

- `4 files / 20 tests passed`

Note:

- the same command fails inside the sandbox with `listen EPERM` and Vitest cache write permission errors
- it was rerun outside the sandbox to complete verification

### Frontend build

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable-next
pnpm --filter @metasheet/web build
```

Result: passed

Observed warning:

- Vite large chunk warning remains, but build succeeded and this round did not materially affect bundle behavior

## Outcome

The clean multitable mainline now protects manager-driven non-grid config persistence at three layers:

- component-level manager behavior
- workbench-level manager integration
- backend/API persistence contract

and the smoke script now checks actual `view-config` persistence instead of only endpoint availability.

## Next

Recommended next slice:

1. Restore live metadata refresh while field/view managers are open so stale-draft protection receives real upstream changes without requiring parent remounts.
2. Continue selectively porting any remaining old-worktree multitable polish only after it is backed by smoke or integration coverage.
