# Multitable Dashboard / Chart Authz Verification (F0b)

Date: 2026-05-30

Design lock: `docs/development/multitable-dashboard-chart-authz-design-20260530.md` (#2125).

## Scope

F0b gates the dashboard/chart module's 11 endpoints:

- Chart config reads require sheet `canRead`; chart config writes require `canManageViews`.
- Dashboard reads require sheet `canRead`; dashboard writes require `canManageViews`.
- `GET /sheets/:sheetId/charts/:id/data` also applies the layer-2 ∧ layer-3 field-read composite to chart field references and returns a restricted empty chart result if a referenced field is not readable.

Out of scope: a new dashboard-specific capability, ownership semantics, central RBAC/auth changes, and wiring a production record provider for chart aggregation.

## Fail-First Evidence

Ran against a fresh local Postgres database migrated with the CI migration exclude list.

Command:

```bash
DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet_f0b_test_79225 \
  pnpm --filter @metasheet/core-backend exec vitest \
  --config vitest.integration.config.ts \
  run tests/integration/multitable-dashboard-chart-authz.test.ts --reporter=dot
```

Origin behavior before the fix:

- `R1` non-reader chart list: `200`, expected `403`.
- `R2` non-reader chart get: `200`, expected `403`.
- `R3` non-reader chart data: `200`, expected `403`.
- `R4` reader chart create: `201`, expected `403`.
- `R5` non-reader dashboard list: `200`, expected `403`.
- `R8` denied chart data: canary label present, expected restricted empty result.

Summary: `6 failed | 3 passed`.

## Post-Fix Verification

Same command after implementation:

```text
Test Files 1 passed (1)
Tests 9 passed (9)
```

Additional local regression checks:

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/dashboard-routes-wiring.test.ts --reporter=dot
```

Result: `7 passed`.

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/dashboard-routes-wiring.test.ts \
  tests/unit/chart-dashboard.test.ts --reporter=dot
```

Result: `56 passed`.

```bash
DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet_f0b_test_79225 \
  pnpm --filter @metasheet/core-backend exec vitest \
  --config vitest.integration.config.ts \
  run tests/integration/multitable-dashboard-chart-authz.test.ts \
      tests/integration/multitable-view-aggregate.test.ts \
      tests/integration/multitable-records-read-field-mask.test.ts \
      tests/integration/multitable-records-list-authz.test.ts \
  --reporter=dot
```

Result: `42 passed`.

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit
pnpm validate:plugins
```

Result: both clean (`validate:plugins` reports existing manifest warnings only; zero errors).

## CI Wiring

`.github/workflows/plugin-tests.yml` now includes:

```text
tests/integration/multitable-dashboard-chart-authz.test.ts
```

under the Node 20 real-DB multitable integration step, so the F0b real-DB tests run in CI and cannot silently skip when `DATABASE_URL` is available.

## Follow-Ups

`metadata.restricted=true` is intentionally returned by the backend. A frontend render affordance for restricted chart data is not included in this backend slice and should be handled as a small UI follow-up if product wants an explicit restricted-state display.
