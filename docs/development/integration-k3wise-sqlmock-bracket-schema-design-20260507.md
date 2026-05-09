# K3 WISE Mock SQL Bracketed Schema Design

Date: 2026-05-07

## Context

The K3 WISE offline PoC uses `mock-sqlserver-executor.mjs` to rehearse the SQL
Server channel before a customer live run. The mock enforces the important
safety contract:

- K3 core tables are read-only.
- Writes are only allowed to `integration_*` middle tables.

SQL Server users commonly write schema-qualified identifiers with brackets,
for example `[dbo].[t_ICItem]` and `[dbo].[integration_material_stage]`.

## Problem

The previous mock table parser handled simple `dbo.t_ICItem`, but treated
`[dbo].[t_ICItem]` as table `dbo`. That caused two PoC realism problems:

- bracketed core-table reads missed canned fixture rows;
- bracketed middle-table writes were rejected as non-middle table writes.

The safety direction for core-table writes was still conservative, but the
false rejections would create avoidable friction when customer engineers use
normal SQL Server syntax in test fixtures.

## Change

`tableNameFromSql()` now parses one-, two-, and three-part SQL identifiers with
any of these forms:

- `dbo.t_ICItem`
- `[dbo].[t_ICItem]`
- `"dbo"."t_ICItem"`
- `[database].[dbo].[t_ICItem]`

The mock uses the last identifier segment as the table name, so schema and
database qualification do not change the safety decision.

## Non-Goals

- This is not a full SQL parser.
- This does not relax the middle-table prefix rule.
- This does not change the real K3 WISE SQL Server channel.
