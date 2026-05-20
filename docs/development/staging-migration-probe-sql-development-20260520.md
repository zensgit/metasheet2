# Staging Migration Probe SQL Development

Date: 2026-05-20

## Summary

This slice extends the staging migration alignment report with a companion
`schema-probes.sql` file. The previous report already produced `report.json`,
`report.md`, and a static Schema Probe Plan. This follow-up turns that plan into
read-only PostgreSQL catalog queries that an operator can run on a cloned or
backed-up rehearsal database.

The script itself still does not connect to a database. It only writes files.

## Files

| File | Change |
| --- | --- |
| `scripts/ops/staging-migration-alignment-report.mjs` | Writes `schema-probes.sql` in addition to `report.json` and `report.md`; adds probe SQL counts to the JSON/Markdown summary. |
| `scripts/ops/staging-migration-alignment-report.test.mjs` | Asserts the generated SQL is read-only and contains table/column/index catalog probes. |
| `docs/operations/staging-migration-alignment-runbook.md` | Documents how operators should use `schema-probes.sql`. |
| `docs/development/staging-migration-probe-sql-development-20260520.md` | This development record. |
| `docs/development/staging-migration-probe-sql-verification-20260520.md` | Verification record for this slice. |

## Probe SQL Shape

The generated SQL uses one unified read-only `probe_plan` CTE over PostgreSQL
`pg_catalog` tables:

| Probe | Catalog source |
| --- | --- |
| Table existence | `pg_catalog.pg_class` + `pg_catalog.pg_namespace` |
| Column existence | `pg_catalog.pg_attribute` + `pg_catalog.pg_class` + `pg_catalog.pg_namespace` |
| Index existence | `pg_catalog.pg_index` + `pg_catalog.pg_class` + `pg_catalog.pg_namespace` |

Every result row reports:

- `probe_type`
- `migration`
- `target`
- `exists`
- `match_count`
- `matched_schemas`

Unqualified table names are not assumed to live in `public`; the SQL reports all
non-system schemas that match.

The file is wrapped in:

```sql
BEGIN READ ONLY;
-- SELECT-only catalog probes
ROLLBACK;
```

## Guardrails

- No migration is executed.
- No `kysely_migration` row is written.
- The generated SQL contains no DDL.
- The script does not read secrets or connect to staging/prod.
- `schema-probes.sql` is an operator aid, not a proof that replaying a migration is
  safe.

## Operator Value

For the current 8082 staging state, the report still says
`do_not_run_full_migrate`. The generated `schema-probes.sql` gives the next rehearsal
step a concrete shape: run read-only catalog checks on a cloned or backed-up DB,
then decide whether specific pending migrations are already satisfied, genuinely
missing, or require idempotency fixes before migration replay.
