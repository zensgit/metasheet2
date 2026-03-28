# Multitable View Manager Config Bridge

Date: 2026-03-26  
Branch: `codex/multitable-next`

## Goal

Bridge the last safe `ViewManager` config methods from legacy `/api/views/:id/config` routes onto the multitable runtime without touching the existing multitable UI WIP.

## Why

After the earlier CRUD/form alignment slices, `ViewManager` still had two legacy config methods:

- `loadViewConfig()`
- `saveViewConfig()`

They still pointed at:

- `GET /api/views/:viewId/config`
- `PUT /api/views/:viewId/config`

That left a contract mismatch:

- create/update/delete/list/submit already used `/api/multitable/*`
- config load/save still used the old view API

This is a good clean slice because the runtime already exposes enough stable multitable primitives:

- `GET /api/multitable/context?viewId=...`
- `PATCH /api/multitable/views/:viewId`

## Design

### Load config from context

`loadViewConfig()` now loads:

- `GET /api/multitable/context?viewId=:viewId`

Then it finds the matching view inside `data.views[]` and converts the runtime `MetaView` shape into the legacy `BaseViewConfig` shape expected by the old `GalleryView`, `FormView`, and `CalendarView`.

### Preserve a legacy-friendly shape

The bridge lifts type-specific runtime `config` payloads back to the top-level legacy fields:

- gallery: `cardTemplate`, `layout`, `display`
- form: `fields`, `settings`, `validation`, `styling`
- calendar: `defaultView`, `weekStartsOn`, `timeFormat`, `fields`, `colors`, `colorRules`, `workingHours`

It also preserves runtime-only metadata on the returned object for later save round-trips:

- `filterInfo`
- `sortInfo`
- `groupInfo`
- `hiddenFieldIds`
- `sheetId`

### Save config back through runtime update

`saveViewConfig()` now serializes the legacy top-level config fields back into the runtime `config` payload and sends:

- `PATCH /api/multitable/views/:viewId`

It passes through the preserved runtime metadata when available so a config-only save does not silently drop view-level filter/sort/group state.

### Intentionally out of scope

This slice still does **not** migrate:

- `loadViewData()`
- `loadViewState()`
- `saveViewState()`
- `getFormResponses()`

Those methods still depend on older read/state endpoints and do not have the same clean one-to-one replacement boundary.

## Files

- `apps/web/src/services/ViewManager.ts`
- `apps/web/tests/view-manager-multitable-contract.spec.ts`
- `packages/core-backend/tests/integration/multitable-context.api.test.ts`

## Outcome

`ViewManager` now uses the multitable runtime consistently for config load/save alongside the already-aligned CRUD/form methods, while keeping the old view components working against their expected legacy config shape. The backend assumption behind `loadViewConfig()` is also locked by a focused `context?viewId=` integration test.
