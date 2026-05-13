# K3 WISE SQL Mock Channel Contract Refresh Development - 2026-05-13

## Context

PR #1335 was still open from the 2026-05-06 K3 WISE stale queue. Its original goal was to align the offline SQL Server mock with the real K3 WISE SQL Server channel contract.

Current `main` already contains a narrower SQL parser hardening from #1404: bracketed and three-part identifiers resolve correctly. The remaining gap was still real:

- The mock executor implemented `query()` and `exec()`.
- The real K3 SQL Server channel requires `queryExecutor.select()` for reads.
- The real K3 SQL Server channel requires `queryExecutor.insertMany()` for middle-table writes.
- `run-mock-poc-demo.mjs` still called `mockSql.query()` directly, so the offline PoC could pass without exercising the real channel read/upsert path.

## Change

This refresh keeps the #1404 identifier coverage and adds the missing channel contract:

- `createMockSqlServerExecutor()` now implements `select()` and `insertMany()`.
- The mock still exposes legacy `query()` and `exec()` for focused SQL safety probes.
- `run-mock-poc-demo.mjs` now calls `sqlChannel.read()` and `sqlChannel.upsert()` before the raw `exec()` core-table write rejection probe.
- `verify:integration-k3wise:poc` now includes `mock-sqlserver-executor.test.mjs`.
- The fixture README documents the real channel contract and the extra local verification command.

## Safety Hardening

The mock parser now treats these as writes or forbidden operations:

- CTE-wrapped mutating SQL, such as `WITH ... DELETE ...`
- `MERGE INTO ...`
- unsupported SQL operations such as `EXEC ...`
- schema DDL verbs such as `CREATE`, `ALTER`, `DROP`, and `TRUNCATE`

Direct writes to K3 core tables remain blocked. Writes to integration middle tables remain allowed.

## Disposition Of Old PR

This current-main refresh supersedes #1335. The old branch lacked the later #1404 identifier tests and should be closed after this branch is opened.

## Files

- `package.json`
- `scripts/ops/fixtures/integration-k3wise/mock-sqlserver-executor.mjs`
- `scripts/ops/fixtures/integration-k3wise/mock-sqlserver-executor.test.mjs`
- `scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs`
- `scripts/ops/fixtures/integration-k3wise/README.md`
- `docs/development/integration-k3wise-sqlmock-channel-contract-refresh-development-20260513.md`
- `docs/development/integration-k3wise-sqlmock-channel-contract-refresh-verification-20260513.md`
