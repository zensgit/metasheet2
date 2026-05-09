# Multitable Gantt Dependencies Verification - 2026-05-06

## Summary

The Gantt dependencies slice was verified with focused frontend tests, frontend type checking, and whitespace checks. The change is frontend-only, so no backend migration or API test is required.

## Commands

```bash
pnpm install --frozen-lockfile
```

Result: pass. The worktree had no linked dependencies before verification, so install was needed to run Vitest and Vue type checking.

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-gantt-view.spec.ts tests/multitable-view-manager.spec.ts --watch=false --reporter=dot
```

Result: pass.

```text
Test Files  2 passed (2)
Tests       20 passed (20)
```

```bash
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
```

Result: pass.

```bash
git diff --check -- apps/web/src/multitable/components/MetaGanttView.vue apps/web/src/multitable/components/MetaViewManager.vue apps/web/src/multitable/types.ts apps/web/src/multitable/utils/view-config.ts apps/web/tests/multitable-gantt-view.spec.ts apps/web/tests/multitable-view-manager.spec.ts
```

Result: pass.

## Coverage Added

- `resolveGanttViewConfig()` returns `dependencyFieldId: null` by default.
- `resolveGanttViewConfig()` accepts valid dependency fields and rejects unsupported field types.
- `MetaGanttView` renders a dependency arrow when the configured dependency field references another scheduled record.
- `MetaViewManager` persists a selected dependency field through Gantt view settings.
- Existing grouped Gantt rendering and toolbar config emission remain covered.

## Notes

- `pnpm install --frozen-lockfile` modified plugin and CLI `node_modules` symlink entries in the worktree. These are dependency-link noise only and are not part of the committed slice.
- The renderer intentionally ignores dependencies that point to records outside the current scheduled result set.
- This verification did not include browser visual QA; the behavior is covered at component DOM level.
