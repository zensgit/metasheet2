# Multitable Gantt Forced Mode Smoke - Development - 2026-05-08

## Context

PR #1440 made the RC Playwright smoke suite usable against staging/142 with
`FE_BASE_URL`, `API_BASE_URL`, and `AUTH_TOKEN`.

The first remote UI run after that bootstrap no longer stopped on the login
page, but the Gantt smoke still failed: the authenticated page showed the
expected records in the workbench grid and never rendered `.meta-gantt__bar` or
`.meta-gantt__dependency-arrow`.

The code path already had a route-level `mode` query intended to force a view
surface:

- `apps/web/src/router/types.ts` allows `mode=grid|form|kanban|gallery|calendar|timeline|gantt|hierarchy`.
- `MultitableEmbedHost.vue` passes `mode` into `MultitableWorkbench.vue`.
- `MultitableWorkbench.vue` documented `mode` as a forced view type.

The implementation only honored `form` and `grid`, so `mode=gantt` could not be
used by remote smoke links to force the Gantt surface.

## Changes

### Workbench forced mode

Updated `apps/web/src/multitable/views/MultitableWorkbench.vue`:

- Added `FORCED_VIEW_MODES`.
- Added `normalizeForcedViewMode(mode)`.
- Changed `activeViewType` to honor any supported forced mode:
  - `grid`
  - `form`
  - `kanban`
  - `gallery`
  - `calendar`
  - `timeline`
  - `gantt`
  - `hierarchy`

This keeps the existing fallback unchanged: if no valid forced mode is present,
the active view row's `type` still drives rendering.

### Gantt smoke URL

Updated `packages/core-backend/tests/e2e/multitable-gantt-smoke.spec.ts`:

- The bar-rendering smoke now opens `/multitable/:sheetId/:viewId?mode=gantt`.
- The dependency-arrow smoke now opens `/multitable/:sheetId/:viewId?mode=gantt`.
- The HTTP validation case is unchanged.

The test still creates and targets a real Gantt view id; `mode=gantt` is only a
UI-surface guard for remote smoke execution.

### Regression tests

Updated `apps/web/tests/multitable-embed-route.spec.ts`:

- Added coverage that `/multitable/sheet_orders/view_gantt?mode=gantt` maps to
  `mode: 'gantt'`.

Updated `apps/web/tests/multitable-workbench-view.spec.ts`:

- Extended the test host to pass `mode`.
- Added coverage that `mode='gantt'` renders `MetaGanttView` even when the
  active view row is otherwise a grid view.

## Non-Goals

- This slice does not change the backend view schema.
- This slice does not change Gantt config validation.
- This slice does not claim 142 is fully green before a new frontend/backend
  deployment. The remote validation must be repeated after this commit reaches
  staging.
