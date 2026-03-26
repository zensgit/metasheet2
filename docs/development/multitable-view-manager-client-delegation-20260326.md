# Multitable View Manager Client Delegation

Date: 2026-03-26  
Branch: `codex/multitable-next`

## Goal

Remove the last duplicated transport/parsing logic from the already-aligned multitable methods in `ViewManager` by delegating them to `MultitableApiClient`.

## Why

After the CRUD and form contract alignment slices, `ViewManager` was already hitting the right multitable endpoints, but it still maintained a parallel hand-written request layer for:

- `createView()`
- `updateView()`
- `deleteView()`
- `getTableViews()`
- `createGalleryView()`
- `createFormView()`
- `submitForm()`

That duplication meant:

- request parsing behavior could drift from `MultitableApiClient`
- error surface could diverge
- future endpoint changes would need to be patched in two places

## Design

### Keep legacy methods isolated

Do **not** migrate the older legacy-only methods in this slice:

- `loadViewConfig()`
- `saveViewConfig()`
- `loadViewData()`
- `loadViewState()`
- `saveViewState()`
- `getFormResponses()`

Those methods still depend on old non-multitable routes and do not yet have a clean runtime replacement.

### Delegate only already-aligned multitable methods

Add a small local factory inside `ViewManager`:

- `createMultitableClient()`

It wraps `MultitableApiClient` with:

- absolute URL resolution via `getApiBase()`
- the same auth header behavior already used by `ViewManager`

Then delegate the aligned methods to that client instead of hand-writing `fetch` + JSON unwrap logic again.

## Files

- `apps/web/src/services/ViewManager.ts`

## Outcome

This slice does not add new product behavior. It improves implementation quality:

- one parser/error path for aligned multitable calls
- less endpoint drift risk
- a clearer boundary between legacy view-service methods and multitable-runtime methods
