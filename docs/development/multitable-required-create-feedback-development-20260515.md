# Multitable Required-Field Create Feedback Development - 2026-05-15

## Summary

This change closes the issue #1526 P0 path where pressing `+ New Record` on a staging/multitable sheet with required fields could fail silently. The backend and API client already returned the required-field validation message. The missing piece was the workbench toolbar create path: it awaited `grid.createRecord()` but did not surface the `grid.error` value that the composable sets when the server rejects the empty record.

## Scope

- Surface `grid.error.value` through the existing workbench toast path immediately after toolbar `createRecord()`.
- Keep the change UI-only. No backend route, schema, migration, plugin runtime, or integration pipeline behavior changes.
- Add regression coverage at both the client boundary and the workbench event wiring boundary.

## Implementation

### Workbench Feedback

`apps/web/src/multitable/views/MultitableWorkbench.vue`

- `onAddRecord()` still delegates record creation to `grid.createRecord()`.
- After the call completes, the workbench now calls `showError(grid.error.value)` when the grid composable recorded a server/client validation failure.
- This preserves the existing composable ownership of API error parsing and avoids duplicating required-field logic in the view.

### API Client Regression

`apps/web/tests/multitable-client.spec.ts`

- Adds coverage for a `POST /api/multitable/records` validation response shaped like the real API envelope:

```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Record validation failed",
    "fieldErrors": {
      "fld_code": "Material Code is required"
    }
  }
}
```

- Verifies that `MultitableApiClient.createRecord()` throws `MultitableApiError` with:
  - HTTP status `422`
  - code `VALIDATION_ERROR`
  - first field error as the user-visible message
  - original `fieldErrors` preserved for structured callers

### Workbench Regression

`apps/web/tests/multitable-workbench-view.spec.ts`

- Extends the mocked `MetaToolbar` with an `add-record` button so the real workbench handler is exercised.
- Adds a regression where `grid.createRecord()` stores `grid.error.value = "Material Code is required"`.
- Verifies the existing toast channel receives that exact message.

## Design Boundaries

- No pre-flight required-field inspection was added to the frontend view. The server remains the source of truth for sheet constraints.
- No new modal/drawer was introduced. This fix intentionally uses the existing toast behavior for create failures.
- No data factory or K3-specific behavior is included. The fix applies to all multitable required-field sheets, including integration staging tables.

## Deployment Impact

- Frontend-only behavior change.
- No database migration.
- No runtime configuration change.
- Safe for Windows on-prem package inclusion because it changes bundled web code and tests only.
