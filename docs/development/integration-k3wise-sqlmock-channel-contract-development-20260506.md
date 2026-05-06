# K3 WISE SQL Mock Channel Contract Development

Date: 2026-05-06

## Context

The K3 WISE fixture mock chain is meant to prove the offline PoC wiring before a
customer run. The SQL Server mock claimed to be compatible with the real K3 WISE
SQL Server channel, but only implemented low-level `query()` and `exec()` probe
methods.

The real channel uses:

- `queryExecutor.select()` for read operations.
- `queryExecutor.insertMany()` for middle-table upsert operations.

Because `run-mock-poc-demo.mjs` called the mock directly, the demo could pass
without exercising the real SQL channel read/upsert contract.

## Implementation

The SQL mock now implements:

- `select({ table, columns, limit, cursor, filters, orderBy, watermark, options, system })`
- `insertMany({ table, records, keyFields, mode, options, system })`

Legacy `query()` and `exec()` remain for focused safety probes.

The demo now calls `sqlChannel.read()` and `sqlChannel.upsert()` before running
the raw core-table write rejection probe.

## Safety Hardening

The mock parser was tightened so PoC safety checks catch more SQL Server shapes:

- `WITH ... DELETE/UPDATE/INSERT/MERGE/...` is treated as a write, not read.
- `MERGE INTO [dbo].[t_ICItem] ...` is rejected as a K3 core-table write.
- unsupported operations such as `EXEC ...` are rejected instead of being logged
  as null-table writes.
- bracket-qualified `[dbo].[t_ICItem]` reads resolve to the canned K3 core table.

## Files Changed

- `package.json`
- `scripts/ops/fixtures/integration-k3wise/mock-sqlserver-executor.mjs`
- `scripts/ops/fixtures/integration-k3wise/mock-sqlserver-executor.test.mjs`
- `scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs`
- `scripts/ops/fixtures/integration-k3wise/README.md`

## CI Integration

`verify:integration-k3wise:poc` now runs the SQL mock contract test before the
mock end-to-end demo. The GitHub `K3 WISE offline PoC` workflow already invokes
that package script.
