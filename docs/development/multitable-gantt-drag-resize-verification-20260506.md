# Multitable Gantt Drag Resize Verification - 2026-05-06

## Summary

The Gantt drag-resize slice was verified with focused component tests, workbench wiring tests, Vue type checking, and whitespace checks.

## Commands

```bash
pnpm install --frozen-lockfile
```

Result: pass. The isolated worktree had no linked dependencies before verification.

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-gantt-view.spec.ts tests/multitable-workbench-view.spec.ts --watch=false --reporter=dot
```

Result: pass.

```text
Test Files  2 passed (2)
Tests       55 passed (55)
```

```bash
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
```

Result: pass.

```bash
git diff --check -- apps/web/src/multitable/components/MetaGanttView.vue apps/web/src/multitable/views/MultitableWorkbench.vue apps/web/tests/multitable-gantt-view.spec.ts apps/web/tests/multitable-workbench-view.spec.ts
```

Result: pass.

## Coverage Added

- Gantt end-handle resize emits `patch-dates` with record id, version, start/end field ids, and ISO date values.
- Read-only Gantt tasks do not expose resize handles.
- Workbench passes scoped edit gating into Gantt.
- Workbench routes Gantt resize updates through `patchRecords`, refreshes the active page, and reports success.
- Existing Gantt config, grouping, dependency arrow, and Workbench Timeline patch tests remain green.

## Regression Found And Fixed

During test development, the first resize assertion exposed a local-time off-by-one conversion risk. The implementation now emits dates with UTC ISO slicing instead of local `setHours(0, 0, 0, 0)` normalization.

## Notes

- `pnpm install --frozen-lockfile` modified plugin and CLI `node_modules` symlink entries in the worktree. These are dependency-link noise only and are not part of the committed slice.
- Browser visual QA was not run in this slice; behavior is covered at DOM-event and workbench-wiring level.
