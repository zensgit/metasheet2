# Multitable F1 Record History Field-Mask Verification — 2026-05-30

## Scope

Implementation for `docs/development/multitable-record-history-field-mask-design-20260530.md`:

- `GET /api/multitable/sheets/:sheetId/records/:recordId/history`
- Value-only response redaction for revision `patch`, `snapshot`, and `changedFieldIds`
- Layer-2 ∧ layer-3 field-read gate, reusing the same allowed-field composite as the interactive read paths
- No mutation of persisted `meta_record_revisions` rows
- Existing sheet-read and record-read gates unchanged

Out of scope: full field-definition strip, other record egress endpoints, dashboard/chart authz, and form/public paths.

## Fail-First Evidence

Command, against a fresh migrated real Postgres database before the route fix:

```bash
DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet_f1hist_test_74665 \
  pnpm --filter @metasheet/core-backend exec vitest \
  --config vitest.integration.config.ts \
  run tests/integration/multitable-record-history-field-mask.test.ts \
  --reporter=dot
```

Result:

- `3 failed | 5 passed`
- `R1` failed because the layer-3 denied canary was present in `patch` / `snapshot`
- `R2` failed because `changedFieldIds` still included the denied/static-hidden fields
- `R3` failed because the static `property.hidden=true` canary was present in `patch` / `snapshot`

This proves the test is not fixture-green and that the leak is on the record-history wire response.

## Post-Fix Evidence

Same command after the route fix:

```text
✓ tests/integration/multitable-record-history-field-mask.test.ts (8 tests)
Test Files 1 passed (1)
Tests 8 passed (8)
```

What the test matrix pins:

- `R1`: `field_permissions.visible=false` values are absent from `patch` and `snapshot`; visible-field values remain
- `R2`: `changedFieldIds` is redacted to the allowed field set
- `R3`: static `property.hidden=true` values are also absent, independent of field_permissions rows
- `R4`: a readable subject with no layer-3 deny still sees readable non-static values
- `R5`: non-readers still receive `403`
- `R6`: missing records still receive `404`
- `R7`: `snapshot: null` remains `null`

## CI Wiring

The test is added to `.github/workflows/plugin-tests.yml` under the Node 20.x real-DB multitable integration step, next to the existing read-path permission suites. This ensures it runs against a real migrated Postgres database in CI, not only locally.

## Commands To Re-Run

```bash
DATABASE_URL=postgresql://chouhua@localhost:5432/<db> \
  pnpm --filter @metasheet/core-backend exec vitest \
  --config vitest.integration.config.ts \
  run tests/integration/multitable-record-history-field-mask.test.ts \
  --reporter=dot

DATABASE_URL=postgresql://chouhua@localhost:5432/<db> \
  pnpm --filter @metasheet/core-backend exec vitest \
  --config vitest.integration.config.ts \
  run \
  tests/integration/multitable-record-history-field-mask.test.ts \
  tests/integration/multitable-records-read-field-mask.test.ts \
  tests/integration/multitable-records-list-authz.test.ts \
  --reporter=dot

pnpm --filter @metasheet/core-backend exec tsc --noEmit
pnpm validate:plugins
```
