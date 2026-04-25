# Integration Core K3 WISE Adapters Verification - 2026-04-24

## Scope

Verify the M2 pre-work adapter skeletons for K3 WISE:

- runtime registration of `erp:k3-wise-webapi`.
- runtime registration of `erp:k3-wise-sqlserver`.
- K3 WISE WebAPI login, health check, save, submit, and audit call ordering.
- K3 WISE WebAPI per-record success/failure accounting.
- K3 WISE SQL Server channel structured read and middle-table write.
- SQL Server channel rejection of raw SQL-like identifiers, non-allowlisted
  tables, and direct K3 production table writes.

## Commands Run

```bash
node -c plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs
node -c plugins/plugin-integration-core/lib/adapters/k3-wise-sqlserver-channel.cjs
node -c plugins/plugin-integration-core/__tests__/k3-wise-adapters.test.cjs
pnpm -F plugin-integration-core test:k3-wise-adapters
```

```bash
pnpm -F plugin-integration-core test
node --import tsx scripts/validate-plugin-manifests.ts
git diff --check
node -c plugins/plugin-integration-core/index.cjs
```

## Results

- New adapter modules pass Node syntax checks.
- New `k3-wise-adapters.test.cjs` passes.
- K3 adapter kinds are wired into runtime status and smoke tests.
- `plugin-integration-core` package tests pass in the PR6 detached tree,
  including all existing M0/M1 smoke, registry, pipeline-runner, REST, staging,
  and migration checks available through PR6.
- Plugin manifest validation passes: 13/13 valid, 0 errors. Existing warnings
  are unrelated plugin metadata/wildcard warnings outside this slice.
- `git diff --check` passes.
- `index.cjs` passes Node syntax check.

## Covered Behaviors

`k3-wise-adapters.test.cjs` covers:

- K3 WISE WebAPI adapter logs in with credential-backed request body.
- K3 WISE WebAPI ignores `config.username/password`; credentials must arrive
  through hydrated `system.credentials`.
- missing hydrated credentials returns `K3_WISE_CREDENTIALS_MISSING` before any
  unauthenticated target write.
- optional health path runs after login.
- `material` and `bom` objects are discoverable.
- `getSchema()` returns configured material fields.
- `upsert()` saves each material record through `Save`.
- `Submit` and `Audit` run only after a successful `Save`.
- a failed record is reported in `errors` without aborting the whole batch.
- `read()` on the WebAPI target adapter rejects with
  `UnsupportedAdapterOperationError`.
- non-http K3 `baseUrl` is rejected.
- SQL Server channel `testConnection()` uses the injected executor.
- SQL Server channel `read()` calls `queryExecutor.select()` with structured
  table, columns, filters, and limit.
- SQL Server channel `upsert()` writes only to a configured middle table through
  `queryExecutor.insertMany()`.
- direct writes to K3 business tables are blocked.
- missing SQL Server executor reports `SQLSERVER_EXECUTOR_MISSING`.
- non-allowlisted read tables are rejected.
- SQL-like table identifiers are rejected before executor dispatch.

Runtime smoke coverage:

- `getStatus().adapters` returns
  `['erp:k3-wise-sqlserver', 'erp:k3-wise-webapi', 'http']`.
- `listAdapterKinds()` returns the same sorted adapter kind list.

## Not Covered

- real K3 WISE customer endpoint connectivity.
- real SQL Server connectivity.
- K3 WISE version-specific WebAPI payload formats.
- customer-specific material/BOM field mappings.
- real approval workflow behavior after `Submit/Audit`.
- production error-code translation.
- high-concurrency idempotency and compensation behavior.

These remain gated by the M2 customer checklist and should be handled in the
customer-environment hardening slice.
