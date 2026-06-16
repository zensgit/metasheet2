# Data Source System Integration C5-1 Verification - MSSQL Helper Contract

Date: 2026-06-15
Scope: C5-1 latent helper contract

## Summary

This slice adds `@metasheet/mssql-readonly-utils`, a neutral workspace package with:

- CJS runtime (`index.cjs`);
- TypeScript declarations (`index.d.ts`);
- package-local CJS and TS consumer tests;
- a core-backend TS consumer smoke;
- a plugin-integration-core CJS consumer smoke.

It does not migrate production call sites. `MSSQLAdapter` and `k3-wise-sqlserver-executor.cjs` continue to use their
existing local logic until C5-2/C5-3.

## Guardrails Verified

- helper exports are read-only by name and shape: no `insert`, `update`, `delete`, `upsert`, `transaction`,
  `rawQuery`, or `execute`;
- helper runtime does not import `packages/core-backend/src/**` or `plugins/plugin-integration-core/**`;
- core-backend source files do not import `plugins/plugin-integration-core/**`;
- plugin-integration-core files do not import `DataSourceManager` or `MSSQLAdapter`;
- generic `WhereClause` keeps `$and` / `$or` / comparison operator support for C3 keyset reads;
- K3 simple SELECT policy rejects unsupported operator objects;
- limit and timeout are policy-driven so generic and K3 behavior can remain different until the dedicated migration
  slices;
- legacy TLS normalization stays per-source and rejects `encrypt=false` combined with legacy TLS options.

## Verification Commands

```bash
pnpm --filter @metasheet/mssql-readonly-utils test
pnpm --filter @metasheet/mssql-readonly-utils build
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/mssql-readonly-utils-consumer.test.ts --reporter=dot
pnpm --filter @metasheet/core-backend build
pnpm --filter plugin-integration-core test:mssql-readonly-utils
pnpm --filter plugin-integration-core test:k3-wise-adapters
pnpm --filter plugin-integration-core test:host-loader
git diff --check
```

## Boundaries

- No route/UI/runtime/package release change.
- No generic MSSQL production behavior change.
- No K3 SQL Server executor production behavior change.
- No K3 Submit/Audit/BOM or external write behavior opened.
- No credential, row value, connection string, raw SQL, or K3 payload evidence added.
