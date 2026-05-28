# Data Factory DF-N2-2a provenance storage verification - 2026-05-28

## Scope

DF-N2-2a is the storage-only sub-slice from
`data-factory-df-n2-2-provenance-runtime-design-20260528.md`.

This PR prepares storage for per-row provenance and intentionally does not write
or read provenance at runtime.

## Files

- `packages/core-backend/migrations/060_integration_runs_provenance.sql`
- `plugins/plugin-integration-core/__tests__/migration-sql.test.cjs`
- `docs/development/data-factory-df-n2-2a-provenance-storage-verification-20260528.md`

## Storage Contract

The migration adds:

- `integration_runs.provenance_events JSONB NOT NULL DEFAULT '[]'::jsonb`
- `integration_provenance_by_row`, a read-only view that unnests run-local
  provenance events by `rowId`

The storage anchor is the existing database table `integration_runs`. The
staging multitable object names `integration_run_log` and
`integration_exceptions` are not DB storage anchors and are not referenced as
SQL objects.

## Boundary Checks

- No new event table.
- No runtime write wiring.
- No read route.
- No frontend.
- No K3 adapter behavior change.
- No Submit / Audit / BOM / multi-record unlock.
- No RBAC or OpenAPI route change.

## Test Coverage

`migration-sql.test.cjs` now checks the 060 migration for:

- JSONB column addition on `integration_runs`
- by-row view creation
- `jsonb_array_elements(... ) WITH ORDINALITY`
- safe handling for non-array / null provenance payloads
- `rowId`, `eventType`, `at`, `attrs`, and raw event projection
- object + `rowId` filtering
- no new table creation or destructive DDL
- no SQL object references to staging multitable object names

## Commands

```bash
node plugins/plugin-integration-core/__tests__/migration-sql.test.cjs
git diff --check
```

Expected result:

- migration SQL structure test passes for 057/058/059/060
- diff check exits 0

## Deferred

- DF-N2-2b: runtime writes to append redacted `ProvenanceEvent` values.
- DF-N2-2c: by-`rowId` GET route, RBAC, OpenAPI parity, and wire-vs-fixture
  route tests.
- DF-N2-3: frontend lineage timeline.
