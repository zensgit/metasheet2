# Data Factory Issue 651 Validation + Project ID Follow-up Development

Date: 2026-05-16

## Scope

This slice closes the two remaining Issue #651 checks after Gate A/B, C2, and C4 had already passed on the on-prem box:

- C1: the real `/multitable` entry reaches `+ New Record`, but blank required fields returned `500 Failed to create meta record` instead of a field-level required message.
- C3: the Data Factory / K3 setup Project ID warning and normalize affordance were not reliably visible after entering a plain project id such as `project_default`.

No migration, integration-core runtime, adapter, or package-build workflow changes are included.

## C1 Design

`RecordService.createRecord()` already runs direct field validation before insert. The weak point was the route/API surface:

- `RecordValidationFailedError` had no code/status metadata.
- `POST /api/multitable/records` returned the old top-level validation shape for one path and could fall through to the generic 500 path if the class identity did not match in a packaged runtime.
- The web client expected `error.fieldErrors` as a map, while direct validation produces an array of `{ fieldId, message }` objects.

The fix makes create-record validation match the multitable client contract:

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

Implementation notes:

- `RecordValidationFailedError` now carries `code = VALIDATION_ERROR` and `statusCode = 422`.
- The route uses a defensive guard that accepts both `instanceof RecordValidationFailedError` and the runtime-safe `{ name: "RecordValidationFailedError", fieldErrors }` shape.
- Route-level field errors are normalized from array or object into `Record<string, string>`.
- The frontend multitable API client also accepts the legacy top-level `{ error, message, fieldErrors: [] }` shape so stale servers still produce a useful toast instead of a generic API message.

## C3 Design

The Project ID logic was correct in computed state, but the on-prem rehearsal showed the interaction was not operator-obvious or robust enough.

The fix keeps the same backend rule:

- empty Project ID means `tenant:integration-core`;
- already-scoped values ending in `:integration-core` or `:plugin-integration-core` pass;
- plain values are warned and can be normalized with one click.

Frontend changes:

- Data Factory Workbench and K3 setup Project ID inputs now use explicit `input`, `change`, and `blur` handlers.
- Both pages render a stable scope status line, so operators can see the effective value even before warning state appears.
- Existing warning + normalize buttons remain, now covered with input/change/blur tests.

## Deployment Impact

- Backend behavior changes only for invalid record-create payloads: `500` becomes `422` with field errors.
- Valid record creation is unchanged.
- Frontend-only Project ID changes affect display/input handling only.
- No database migration required.

