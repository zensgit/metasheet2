# Multitable Default Entry Development - 2026-05-17

## Purpose

This change makes Multitable the default table-facing product entry.

Before this slice, the platform shell exposed legacy `/grid` and `/spreadsheets` links as first-class navigation items and the platform home redirect defaulted to `/grid`. That was misleading because `/grid` and `/spreadsheets` are legacy spreadsheet/cell-model surfaces, while the Feishu Base parity work lives under `/multitable/:sheetId/:viewId`.

## Scope

In scope:

- Add a `/multitable` home route.
- Add a lightweight Multitable home page that lists accessible bases and opens the first available sheet/view.
- Allow creating a new Base plus seeded Sheet from the Multitable home page.
- Remove `/grid` and `/spreadsheets` from the default platform navigation.
- Keep `/grid` and `/spreadsheets` routes alive for backward compatibility.
- Change platform home/onboarding defaults from `/grid` to `/multitable`.
- Update tests for the new navigation contract and Multitable home behavior.

Out of scope:

- No deletion of legacy Grid or Spreadsheet routes.
- No migration, schema change, or backend route rewrite.
- No changes to the `/api/spreadsheets` cell model.
- No changes to Data Factory, K3, Attendance, DingTalk, or Phase 3 deferred lanes.

## Implementation

### Route Contract

`apps/web/src/router/types.ts` now defines:

- `AppRouteNames.MULTITABLE_HOME`
- `ROUTE_PATHS.MULTITABLE_HOME = '/multitable'`

`apps/web/src/router/appRoutes.ts` registers the static `/multitable` route before the parameterized `/multitable/:sheetId/:viewId` route. This ordering is required so the home page is not interpreted as `{ sheetId: 'multitable' }`.

### Home Page

`apps/web/src/views/MultitableHomeView.vue` is intentionally small and uses the existing `MultitableApiClient`:

- `listBases()` loads accessible bases.
- `loadContext({ baseId })` resolves the first sheet/view when opening a base.
- `createBase({ name })` plus `createSheet({ baseId, name: 'Sheet 1', seed: true })` creates an immediately usable workspace.
- Navigation uses `AppRouteNames.MULTITABLE` and preserves `baseId` in query params.

This avoids adding a new backend endpoint and keeps the home page aligned with existing workbench context semantics.

### Navigation

`apps/web/src/App.vue` now shows a single Multitable nav link in the default platform shell:

- Removed primary nav links to `/grid` and `/spreadsheets`.
- Added primary nav link to `/multitable`.

The old routes still exist in `appRoutes.ts`, so existing deep links and legacy tests remain valid.

### Default Home

`apps/web/src/stores/featureFlags.ts` now returns `/multitable` for the generic platform home. Attendance-focused and PLM-focused modes keep their existing redirects.

`packages/core-backend/src/auth/access-presets.ts` now sets platform onboarding `homePath` to `/multitable` and grants `multitable:read` / `multitable:write` in the platform presets while preserving legacy spreadsheet permissions.

## Files

- `apps/web/src/views/MultitableHomeView.vue`
- `apps/web/src/router/types.ts`
- `apps/web/src/router/appRoutes.ts`
- `apps/web/src/App.vue`
- `apps/web/src/stores/featureFlags.ts`
- `apps/web/tests/multitable-home-view.spec.ts`
- `apps/web/tests/platform-shell-nav.spec.ts`
- `packages/core-backend/src/auth/access-presets.ts`

## Compatibility Notes

- `/grid` remains routable.
- `/spreadsheets` and `/spreadsheets/:id` remain routable.
- `/api/spreadsheets` remains untouched.
- This change is presentation and entry-routing only; it does not merge the spreadsheet cell model into Multitable.

