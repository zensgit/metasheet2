# Multitable View Manager Contract Alignment

Date: 2026-03-26  
Branch: `codex/multitable-next`

## Goal

Align the legacy `ViewManager` service with the current multitable runtime CRUD contracts so operator docs, backend routes, and frontend service calls all point at the same endpoint family.

## Problem

`apps/web/src/services/ViewManager.ts` still used legacy routes for CRUD:

- `POST /api/views`
- `PUT /api/views/:id`
- `DELETE /api/views/:id`
- `GET /api/tables/:id/views`

But the live multitable runtime is already on:

- `POST /api/multitable/views`
- `PATCH /api/multitable/views/:viewId`
- `DELETE /api/multitable/views/:viewId`
- `GET /api/multitable/views?sheetId=...`

That meant the service layer could silently drift away from the runtime even while the newer `MultitableApiClient` stayed correct.

## Scope

### Frontend service

Update `ViewManager` CRUD methods only:

- `createView()`
- `updateView()`
- `deleteView()`
- `getTableViews()`

and align their response parsing from legacy `success/data` to runtime `ok/data.view|views|deleted`.

### Frontend verification

Add an isolated service spec so this alignment is locked without touching the in-progress workbench UI files.

### Backend verification

Add focused integration coverage for:

- `DELETE /api/multitable/views/:viewId` success
- `DELETE /api/multitable/views/:viewId` not found

## Files

- `apps/web/src/services/ViewManager.ts`
- `apps/web/tests/view-manager-multitable-contract.spec.ts`
- `packages/core-backend/tests/integration/multitable-view-config.api.test.ts`

## Design Notes

- This slice deliberately does not rewrite the broader legacy `ViewManager` config/data/state endpoints; it only fixes the CRUD surface that directly overlaps with the current multitable runtime and pilot operator flows.
- The new frontend spec mocks `useAuth()` and `getApiBase()` so the service contract stays testable without mounting any Vue workbench surface.
- Backend delete-view coverage lives next to the existing view-config integration tests because it exercises the same runtime route family and DB object (`meta_views`).
