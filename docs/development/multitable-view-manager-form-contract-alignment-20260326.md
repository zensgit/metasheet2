# Multitable View Manager Form Contract Alignment

Date: 2026-03-26  
Branch: `codex/multitable-next`

## Goal

Finish the low-risk `ViewManager` runtime alignment for the methods that already have a direct multitable backend contract:

- `createGalleryView()`
- `createFormView()`
- `submitForm()`

## Problem

After the CRUD alignment slice, `ViewManager` still had three legacy view-form endpoints wired in:

- `POST /api/views/gallery`
- `POST /api/views/form`
- `POST /api/views/:viewId/submit`

But the active multitable runtime already uses:

- generic view creation via `POST /api/multitable/views`
- form submit via `POST /api/multitable/views/:viewId/submit`

That left the legacy service half-modernized: view CRUD was correct, but gallery/form creation and form submit could still drift from runtime.

## Scope

### `createGalleryView()`

Map legacy gallery config into a generic multitable create-view request:

- use `tableId` as `sheetId`
- keep `type: 'gallery'`
- move gallery-specific payload into `config`

### `createFormView()`

Map legacy form config the same way:

- use `tableId` as `sheetId`
- keep `type: 'form'`
- move form-specific payload into `config`

### `submitForm()`

Switch to:

- `POST /api/multitable/views/:viewId/submit`

and adapt the runtime response back into the older `FormSubmissionResponse` compatibility shape:

- `success: true`
- `data.id = record.id`
- `data.message = Form submitted successfully | Form updated successfully`

## Explicit Non-Goals

This slice does **not** rewrite:

- `loadViewConfig()`
- `saveViewConfig()`
- `loadViewData()`
- `loadViewState()`
- `saveViewState()`
- `getFormResponses()`

Those methods still depend on legacy non-multitable endpoints or data contracts that do not have a one-to-one runtime replacement in this worktree.

## Files

- `apps/web/src/services/ViewManager.ts`
- `apps/web/tests/view-manager-multitable-contract.spec.ts`

## Design Notes

- The compatibility layer stays intentionally thin. The goal is to align transport and normalize the result, not to redesign the old view service surface.
- Returning the legacy `FormSubmissionResponse` shape avoids breaking `FormView.vue` while still ensuring requests hit the real multitable submit runtime.
