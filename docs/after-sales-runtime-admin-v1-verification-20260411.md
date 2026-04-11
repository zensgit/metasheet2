# After-Sales Runtime Admin V1 Verification

Date: 2026-04-11
Branch: `feature/after-sales-runtime-admin-v1`

## Summary

Runtime admin v1 was verified across backend unit tests, backend real-DB integration, frontend view tests, and production builds for both packages.

Docs-only wrap-up branch was also landed first:

- PR `#785`
- merged at `2026-04-11T00:46:04Z`
- merge commit `2fd9b4ff6d5f324135875bf5b06586ce24496d70`

## Commands Run

### Backend

```bash
pnpm install
pnpm --filter @metasheet/core-backend test:unit
DATABASE_URL=postgresql://metasheet:metasheet123@localhost:5432/metasheet_v2 \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/after-sales-plugin.install.test.ts --reporter=dot
pnpm --filter @metasheet/core-backend build
```

### Frontend

```bash
pnpm --filter @metasheet/web exec vitest run tests/AfterSalesView.spec.ts --watch=false
pnpm --filter @metasheet/web exec vitest run \
  tests/AfterSalesView.spec.ts \
  tests/AfterSalesView.follow-ups.spec.ts \
  tests/AfterSalesView.customers.spec.ts \
  tests/AfterSalesView.installed-assets.spec.ts \
  tests/AfterSalesView.service-records.spec.ts \
  --watch=false
pnpm --filter @metasheet/web build
```

## Results

Backend unit suite:

- `69` test files passed
- `731` tests passed

Backend integration:

- `tests/integration/after-sales-plugin.install.test.ts`
- `24` tests passed
- includes new runtime-admin coverage for:
  - admin GET
  - automation toggle persistence
  - field-policy update persistence
  - finance-user effective policy refresh
  - non-admin `403`

Frontend view suite:

- `tests/AfterSalesView.spec.ts`: `27` tests passed
- all `AfterSalesView*` specs together: `74` tests passed

Builds:

- `@metasheet/core-backend` build passed
- `@metasheet/web` build passed

## Manual Verification Notes

Observed backend/runtime behavior from automated coverage:

- `/api/after-sales/runtime-admin` returns 4 default automations with manifest-aligned names
- disabling `sla-watcher` persists to `plugin_automation_rule_registry`
- saving a hidden finance policy is persisted as `hidden + readonly`
- finance user effective field policy updates immediately after admin save
- non-admin callers receive `403 FORBIDDEN`

Observed UI behavior from frontend tests:

- runtime-admin panel renders only when supported and accessible
- `403` hides the panel without breaking the rest of `AfterSalesView`
- automation save sends the minimal `{ id, enabled }` payload
- field-policy save sends role matrix payload and refreshes refund controls
- existing installed-assets / customers / follow-ups / service-records panels still pass their test suites

## Non-Blocking Warnings

Frontend build emitted pre-existing Vite warnings:

- dynamic/static mixed import warning for `WorkflowDesigner.vue`
- large chunk size warnings in the web build

These warnings did not block the build and were not introduced by the runtime-admin slice.
