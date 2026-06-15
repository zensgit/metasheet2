# Data Source System Integration C5-3 Verification - K3 SQL Server Executor Helper Wire

Date: 2026-06-15
Scope: C5-3 K3 default SQL Server executor minimal helper wire

## Summary

This slice wires the built-in `erp:k3-wise-sqlserver` read-only executor to the neutral
`@metasheet/mssql-readonly-utils` helper introduced in C5-1.

Migrated to helper:

- SQL Server endpoint parsing for `server` / optional `port`;
- timeout and limit normalization, with the K3 executor's existing policy values;
- SQL Server identifier quoting primitive;
- structured simple `SELECT TOP ... FROM ... WHERE ... ORDER BY ...` query construction.

Kept K3-local:

- K3 strict identifier policy remains the first gate before the helper is called: at most `schema.table`, and every
  segment must start with a letter or underscore;
- K3 object manifests, read/write table allowlists, operation checks, and direct-table write gate stay in the K3 SQL
  Server channel;
- the built-in executor's `insertMany` still throws `SQLSERVER_WRITE_EXECUTOR_DISABLED`;
- Submit / Audit / BOM / generic DB write remain unopened.

## Guardrails Verified

- Existing SQL Server channel tests still assert the exact structured SELECT SQL and bound parameters.
- The executor now accepts shared-helper endpoint coverage for SQL Server named instances with ports
  (`server\instance,port`).
- Regression tests pin that the K3 executor does not inherit the generic helper's wider identifier policy:
  `tenant.dbo.table` and numeric-leading identifiers still fail closed before helper query construction.
- The plugin CJS consumer smoke still resolves `@metasheet/mssql-readonly-utils`.
- The helper contract suite still confirms the helper package stays neutral and read-only.

## Verification Commands

```bash
pnpm --filter plugin-integration-core test:k3-wise-adapters
pnpm --filter plugin-integration-core test:mssql-readonly-utils
pnpm --filter @metasheet/mssql-readonly-utils test
```

## Boundaries

- No `DataSourceManager` or generic `MSSQLAdapter` dependency added to the K3 plugin path.
- No route, UI, migration, package release, or entity-machine smoke change.
- No K3 Save / Submit / Audit / BOM behavior opened.
- No generic DB write behavior opened.
- No credentials, row values, connection strings, raw SQL evidence, or K3 payloads added to docs.
