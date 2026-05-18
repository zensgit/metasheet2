# Data Factory Issue #651 Record Create Context Follow-up

Date: 2026-05-17

## Purpose

This change closes the remaining C1 failure reported from the Windows on-prem retest of package
`metasheet-multitable-onprem-v2.5.0-issue651-c1-context-5b19e3.zip`.

The previous fix changed the backend response from a generic 500 to a precise
`400 VALIDATION_ERROR: sheetId or viewId is required`, proving the create request still reached
`POST /api/multitable/records` without record-create context. This follow-up makes context recovery
more tolerant of real deployed route shapes before the request reaches field validation.

## Root Cause

`useMultitableGrid.createRecord()` had a route fallback, but it only read `globalThis.location.pathname`.
The physical retest showed the authenticated multitable route could be opened, while `+ New Record`
still posted a bare `{ data: ... }` body.

That leaves two credible production gaps:

- The browser route context can be present in a full `href`, hash route, or query fallback rather than
  only `pathname`.
- Even if the frontend composable loses context during mount/navigation timing, the backend request
  still carries a same-page `Referer` for authenticated `/multitable/:sheetId/:viewId` pages in normal
  deployments.

## Design

### Frontend context recovery

`apps/web/src/multitable/composables/useMultitableGrid.ts` now resolves create context from:

- explicit composable refs: `opts.sheetId`, `opts.viewId`
- full browser location: `href`, `pathname`, `hash`, `search`
- authenticated `/multitable/:sheetId/:viewId` route segments
- hash-backed routes such as `#/multitable/:sheetId/:viewId`
- query fallbacks such as `?sheetId=...&viewId=...`

Public-form routes remain excluded, so an authenticated record-create request does not borrow
`/multitable/public-form/:sheetId/:viewId`.

### Backend last-resort recovery

`packages/core-backend/src/routes/univer-meta.ts` now exports and uses
`extractMultitableRecordCreateContextFromUrl()`.

If the request body omits both `sheetId` and `viewId`, `POST /api/multitable/records` tries to recover
context from `Referer` / `Referrer`. The recovered context then goes through the existing
`resolveMetaSheetId()` and capability checks. This is not a permission bypass: the authenticated user
still needs sheet access, and public-form routes are ignored.

## Expected Behavior

For Data Factory staging links:

1. User opens the generated authenticated `/multitable/...` staging table link.
2. User clicks `+ New Record`.
3. The create body includes `sheetId` / `viewId`, or the backend recovers them from Referer.
4. The request reaches field-level validation.
5. Empty Standard Materials create should surface required-field validation such as
   `Material Code is required` instead of `sheetId or viewId is required`.

## Deployment Impact

- No migration.
- No new API route.
- No integration-core business-path change.
- Safe to ship in the Windows on-prem package as a frontend/backend robustness fix.
