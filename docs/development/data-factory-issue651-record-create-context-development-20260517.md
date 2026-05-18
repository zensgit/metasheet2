# Data Factory Issue 651 Record Create Context Development - 2026-05-17

## Summary

The Windows on-prem retest of `metasheet-multitable-onprem-v2.5.0-k3wise-c1-repair-1c0f6e7.zip` narrowed the remaining C1 failure to a context loss in the `+ New Record` path:

```text
[univer-meta] create record failed: ValidationError: sheetId or viewId is required
```

That means the request failed before staging required-field validation could run. The repair migration was applied, so this is no longer a schema-gap issue.

## Scope

- Preserve the existing `/multitable/:sheetId/:viewId` direct route.
- Keep the server as the source of truth for field-level required validation.
- Add a frontend guard so authenticated multitable record creation never posts a bare `{ data: ... }` body when the current route already carries `sheetId` and `viewId`.
- Add a backend guard so missing context returns `400 VALIDATION_ERROR` instead of being logged and surfaced as `500 Failed to create meta record`.
- No migration, plugin runtime, Data Factory pipeline, or K3 WISE adapter change.

## Implementation

### Frontend Context Fallback

File: `apps/web/src/multitable/composables/useMultitableGrid.ts`

`createRecord()` now resolves context in this order:

1. `opts.sheetId.value` / `opts.viewId.value` from the workbench state.
2. The current browser path when it matches the authenticated route `/multitable/:sheetId/:viewId`.

If route fallback is used, the composable hydrates the blank refs before posting so the reload path uses the same context. It deliberately ignores `/multitable/public-form/:sheetId/:viewId`; public-form creation continues through the form-submit API, not the authenticated `/records` API.

If neither workbench state nor route state contains a sheet or view id, the composable sets `grid.error.value = "sheetId or viewId is required"` and does not call the API.

### Backend Error Mapping

File: `packages/core-backend/src/routes/univer-meta.ts`

`POST /api/multitable/records` already used `resolveMetaSheetId()` before creating records. That helper throws the local `ValidationError` for missing context, but the route did not catch this error class in the create path. The route now maps it to:

```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "sheetId or viewId is required"
  }
}
```

This prevents the generic 500 wrapper from hiding a client-context issue.

## Expected On-Prem Behavior

With the same Data Factory staging path:

1. Open Data Factory.
2. Generate/open the real `Standard Materials` `/multitable/:sheetId/:viewId` link.
3. Click `+ New Record`.

Expected outcome:

- The frontend request body includes `sheetId` and `viewId`.
- The backend reaches staging required-field validation.
- The user sees the field-level toast such as `Material Code is required`.
- No generic `500 INTERNAL_ERROR / Failed to create meta record` appears for missing sheet/view context.

## Deployment Impact

- Frontend bundle changes.
- Backend route error mapping change.
- No database migration.
- Safe for Windows on-prem package rebuild; the package verify gate does not need a new content assertion because this is runtime behavior covered by tests and docs.
