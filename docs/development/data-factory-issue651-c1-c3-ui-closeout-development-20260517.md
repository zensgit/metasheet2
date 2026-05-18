# Data Factory Issue 651 C1/C3 UI Closeout - Development Notes

Date: 2026-05-17

## Purpose

This note closes the two remaining page-level items from issue #651:

- C1: adding an empty record in the real multitable page should surface field-level required errors instead of a generic backend failure.
- C3: the K3 WISE Project ID field should make the effective integration scope visible and provide a one-click normalization path for non-scoped values.

No new runtime code is introduced by this closeout note. The current `origin/main` already contains the fixes required for both items; this branch records the implementation contract and verification evidence.

## C1 Implementation Contract

The backend record-create path can return validation errors in the legacy top-level shape:

```json
{
  "error": "VALIDATION_FAILED",
  "message": "Record validation failed",
  "fieldErrors": {
    "fld_code": "Material Code is required"
  }
}
```

The frontend multitable API client must normalize both supported shapes:

- Envelope shape: `error.fieldErrors`
- Legacy shape: top-level `fieldErrors`

The client then uses the first field-level error as the thrown message. That keeps `MultitableWorkbench` unchanged: `onAddRecord()` still calls `grid.createRecord()` and shows `grid.error.value`, but the value is now the actionable field message.

## C3 Implementation Contract

K3 WISE setup treats Project ID as advanced and optional.

- Blank Project ID resolves to `<tenantId>:integration-core`.
- Already scoped Project ID is accepted as-is when the final `:` segment is `integration-core` or `plugin-integration-core`.
- Plain Project ID shows a warning and can be normalized with one click by appending `:integration-core`.

The Data Factory workbench and K3 preset page share the same scope rule through `normalizeIntegrationProjectId()` and `isIntegrationScopedProjectId()`.

## Deployment Impact

No migration, backend route, plugin runtime, adapter, or package-build change is required for this closeout. The fix is frontend/API-client behavior already present on latest main and verified against the 142 deployment.

## Issue Status

After verification:

- Gate A: pass
- Gate B: pass
- C1: pass
- C2: pass
- C3: pass
- C4: pass

The remaining customer-facing constraint is not a UI repair item: live K3 WISE read/list runtime is still gated by customer GATE responses and the Stage 1 Lock.
