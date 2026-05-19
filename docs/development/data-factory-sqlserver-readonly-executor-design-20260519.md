# Data Factory SQL Server Read-Only Executor - Design - 2026-05-19

## Context

Issue #1526 bridge smoke reached the point where Data Factory can save and
dry-run staging-to-K3 pipelines, but the K3 WISE SQL Server source still reports
`SQLSERVER_EXECUTOR_MISSING`. That blocks allowlisted SQL Server sampling and
prevents the bridge machine from using K3 SQL views/tables as a Data Factory
source.

This slice intentionally breaks the earlier Stage 1 "no integration-core touch"
constraint only for this narrow runtime gap. It does not implement K3 WebAPI
read/list, relationship resolution, raw SQL, or real K3 writes.

## Runtime Change

Added `plugins/plugin-integration-core/lib/adapters/k3-wise-sqlserver-executor.cjs`.

The executor:

- lazily loads the packaged `mssql` dependency;
- builds a SQL Server connection from the decrypted adapter system credentials
  and JSON config (`server`, `database`, optional `port`, timeout and TLS flags);
- runs a fixed `SELECT 1 AS ok` for connection tests;
- runs only structured `SELECT TOP <limit>` reads for adapter-provided
  table/object config;
- quotes identifiers after validating simple `schema.table` / `column` names;
- parameterizes filter and watermark values;
- returns `{ records, nextCursor: null, done: true }`;
- keeps `insertMany()` disabled with `SQLSERVER_WRITE_EXECUTOR_DISABLED`.

The plugin activation now registers:

```js
createK3WiseSqlServerChannelFactory({ queryExecutor: sqlServerQueryExecutor })
```

so a normal packaged deployment no longer depends on an out-of-band bridge patch
for read-only SQL source testing.

## Safety Boundaries

- No raw SQL string is accepted from UI, pipeline options, request body, or
  customer JSON.
- Table and column names must pass the adapter identifier guard.
- Read allowlists remain enforced by `k3-wise-sqlserver-channel.cjs` before the
  executor runs.
- Built-in writes remain disabled. Middle-table writes still require a custom
  deployment-owned executor.
- Error results avoid returning credentials or connection strings.

## Package Impact

`plugin-integration-core` now declares `mssql` as a runtime dependency. The
Windows/on-prem package already ships workspace `package.json` and
`pnpm-lock.yaml`, and deploy helpers run `pnpm install --frozen-lockfile` when
`node_modules` is absent. The package verifier now fails if:

- the executor file is missing;
- the plugin package does not declare `mssql`;
- plugin activation does not inject the built-in query executor;
- the executor loses the bounded `SELECT TOP` or write-disabled markers.

## Non-goals

- No K3 WebAPI read/list runtime.
- No relationship resolver runtime.
- No SQL write support in the built-in executor.
- No direct K3 core-table writes.
- No Save / Submit / Audit behavior change.
