# Multitable F2 Records-Summary Field-Mask Verification — 2026-05-30

## Scope

Implements F2 from `docs/development/multitable-record-egress-fieldperm-inventory-20260529.md` / PR #2106:

- Endpoint: `GET /api/multitable/records-summary`
- Gate caller-controlled `displayFieldId` against the layer-2 ∧ layer-3 allowed-field set
- Reject denied and non-existent `displayFieldId` with the same generic `400` response
- When `displayFieldId` is omitted, choose the default display field from readable fields only
- Keep scope to records-summary; link-options/person-fields remain separate F5 follow-up

## Fail-First Evidence

Command, against a fresh migrated real Postgres database before the route fix:

```bash
DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet_f2summary_test_48689 \
  pnpm --filter @metasheet/core-backend exec vitest \
  --config vitest.integration.config.ts \
  run tests/integration/multitable-records-summary-field-mask.test.ts \
  --reporter=dot
```

Result:

- `5 failed | 2 passed`
- `R1`: explicit layer-3 denied `displayFieldId` returned `200`, exposing bulk display values
- `R2`: non-existent `displayFieldId` returned `200` instead of the generic rejection
- `R3`: omitted `displayFieldId` defaulted to the first string field even though it was denied
- `R4`: `search` filtered against the denied default display field
- `R6`: static `property.hidden=true` `displayFieldId` returned `200`

This proves both explicit and default display-field paths were reachable leaks before the fix.

## Post-Fix Evidence

Same command after the route fix:

```text
✓ tests/integration/multitable-records-summary-field-mask.test.ts (7 tests)
Test Files 1 passed (1)
Tests 7 passed (7)
```

What the test matrix pins:

- `R1`: denied `displayFieldId` is rejected with generic `400` and no canary values
- `R2`: non-existent `displayFieldId` gets the same generic `400`, avoiding a field-existence oracle
- `R3`: omitted `displayFieldId` falls back to the first readable field
- `R4`: search applies to the readable effective display field only
- `R5`: a readable subject with no layer-3 deny can still use the requested display field
- `R6`: static hidden fields are rejected by the same gate

## CI Wiring

The test is added to `.github/workflows/plugin-tests.yml` under the Node 20.x real-DB multitable integration step, next to the existing read-path permission suites.

## Commands To Re-Run

```bash
DATABASE_URL=postgresql://chouhua@localhost:5432/<db> \
  pnpm --filter @metasheet/core-backend exec vitest \
  --config vitest.integration.config.ts \
  run tests/integration/multitable-records-summary-field-mask.test.ts \
  --reporter=dot

DATABASE_URL=postgresql://chouhua@localhost:5432/<db> \
  pnpm --filter @metasheet/core-backend exec vitest \
  --config vitest.integration.config.ts \
  run \
  tests/integration/multitable-records-summary-field-mask.test.ts \
  tests/integration/multitable-records-read-field-mask.test.ts \
  tests/integration/multitable-records-list-authz.test.ts \
  tests/integration/multitable-record-history-field-mask.test.ts \
  --reporter=dot

pnpm --filter @metasheet/core-backend exec tsc --noEmit
pnpm validate:plugins
```
