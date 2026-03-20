# Multitable Grid Hardening Recut Development

Date: 2026-03-20

## Scope

Re-cut the next smallest safe multitable slice from current `main` after merged PR `#508`.

Included:

- `apps/web/src/multitable/composables/useMultitableGrid.ts`
- `apps/web/tests/multitable-grid.spec.ts`
- `apps/web/tests/multitable-phase15.spec.ts`

Excluded on purpose:

- `apps/web/src/multitable/views/MultitableWorkbench.vue`
- `apps/web/tests/multitable-conflict-ux.spec.ts`
- pilot/profile workflows and smoke scripts
- attachment/import/backend/openapi follow-up work

## Changes

1. Added stale-response protection in `useMultitableGrid` so older requests cannot overwrite the latest grid page state.
2. Added pagination fallback when the requested offset lands beyond the server's new total after data shrink.
3. Clamped `goToPage()` to the current total page range and skipped redundant reloads when the resolved offset matches the current page.
4. Reduced search debounce from `300ms` to `150ms`.
5. Skipped redundant search reloads when the query value is unchanged.
6. Added targeted tests for stale response handling, pagination fallback, page clamp/no-op behavior, and unchanged-search no-op behavior.

## Recut Notes

The original branch also contained conflict-banner work in `MultitableWorkbench.vue`, but current `main` has already evolved around attachment/form flows in that file. Carrying the older view layer wholesale would have increased merge risk without improving this slice's core value.

This recut therefore keeps the slice at the grid state-management layer only.
