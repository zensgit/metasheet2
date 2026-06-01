# Multitable cross-sheet related echo mask verification

**Date:** 2026-06-01
**Design-lock:** `docs/development/multitable-cross-sheet-related-echo-mask-design-20260601.md` (#2176)
**Scope:** cross-sheet `relatedRecords` write echo from `POST /patch`; no realtime broadcast, F4 create echo, or F5 summary paths.

## Implementation

`computeDependentLookupRollupRecords` now computes a per-related-sheet allowed-field set before emitting related computed records:

1. Group dependent records by their own `sheetId`.
2. Resolve `resolveSheetReadableCapabilities(req, query, relatedSheetId)`.
3. Drop the related sheet if there is no subject or `canRead=false`.
4. Load that related sheet's `field_permissions` for the subject.
5. Reuse `computeAllowedFieldIds(fields, capabilities, fieldScopeMap)` — layer-2 `property.hidden` ∧ layer-3 `field_permissions.visible`, with `hiddenFieldIds: []`.
6. Emit `filterRecordDataByFieldIds(extractLookupRollupData(fields, row.data), allowedFieldIds)`.

This deliberately does **not** reuse the edited sheet's F3 `readableEchoFieldIds`. `RecordWriteService` remains permission-service agnostic; the fix stays at the route helper / producer seam.

## Fail-first proof

New real-DB test: `packages/core-backend/tests/integration/multitable-cross-sheet-related-echo-mask.test.ts`.

Temporary pre-fix run, with only the implementation hunk reverted and the new test kept:

```text
FAIL R1-R4/R6: expected [ Array(1) ] to be undefined
at B_LOOKUP_SECRET
```

That is the live leak: a user who can write source sheet A and read related sheet B, but has `field_permissions.visible=false` for B's computed lookup field, received `relatedRecords[].data[B_LOOKUP_SECRET]` containing the secret lookup value.

R5 stayed green in the pre-fix run, confirming the existing sheet-level `resolveReadableSheetIds` boundary: unreadable related sheets were already dropped. The fix targets field-level masking within readable related sheets.

## Tests

Local verification against a fresh migrated `metasheet_test`:

```text
DATABASE_URL=postgresql:///metasheet_test pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-cross-sheet-related-echo-mask.test.ts
✓ 3 passed

DATABASE_URL=postgresql:///metasheet_test pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-write-echo-field-mask.test.ts
✓ 5 passed

pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-record-patch.api.test.ts
✓ 6 passed

pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-patch-partial-success.api.test.ts
✓ 2 passed

pnpm --filter @metasheet/core-backend exec tsc --noEmit
✓ clean
```

The new test is wired into `.github/workflows/plugin-tests.yml` under the existing Node 20.x real-DB multitable integration step, so CI must run it against fresh Postgres.

## What remains out of scope

- Realtime broadcast unmasked patches (`record-write-service.ts` broadcast payload) — separate per-recipient design.
- F4 create echo.
- F5 link-options/person-fields.
- Full field-definition strip.
