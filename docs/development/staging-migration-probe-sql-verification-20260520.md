# Staging Migration Probe SQL Verification

Date: 2026-05-20

## Scope

Verify the `schema-probes.sql` output added to the read-only staging migration
alignment report.

No staging DB migration was executed. No `kysely_migration` row was written.

## Checks

| Check | Result |
| --- | --- |
| `node --check scripts/ops/staging-migration-alignment-report.mjs` | PASS |
| `node --test scripts/ops/staging-migration-alignment-report.test.mjs` | PASS, 7 tests |
| `git diff --check` | PASS |
| Live 8082 staging read-only report generation | PASS |

## Unit Coverage

The test suite now asserts:

- `schema-probes.sql` is written next to `report.json` and `report.md`;
- generated SQL starts a read-only transaction;
- probes use `pg_catalog` directly rather than `information_schema`;
- table, column, and index probes share one `probe_plan` CTE;
- unqualified table names render as `schema_name IS NULL`, so matches can be
  reported across non-system schemas instead of assuming `public`;
- generated rows expose `exists`, `match_count`, and `matched_schemas`;
- generated SQL does not contain DDL such as `CREATE TABLE`, `ALTER TABLE`, or
  `DROP TABLE`;
- the full Schema Probe Plan is emitted to SQL, even though the Markdown
  preview is truncated for readability;
- Kysely create-table migrations produce table, column, and index probe counts.

## Live 8082 Staging Read-Only Output

Generated from staging `migrate --list` output on 2026-05-20 without executing
migrations:

| Metric | Value |
| --- | --- |
| Applied migrations | 86 |
| Pending migrations | 77 |
| Decision | `do_not_run_full_migrate` |
| Probe plan entries | 76 |
| Probe SQL table targets | 207 |
| Probe SQL column targets | 2069 |
| Probe SQL index targets | 431 |
| `schema-probes.sql` size | 270673 bytes |

Risk counts:

| Risk | Count |
| --- | --- |
| `high` | 12 |
| `ledger_review` | 29 |
| `medium` | 5 |
| `low` | 31 |

The generated `schema-probes.sql` was written under local untracked `output/` and is not
committed.

## Boundary Verification

- The live step only captured `migrate --list` output from staging.
- `schema-probes.sql` was generated locally from static analysis.
- No token/JWT paths were committed.
- The script still does not connect to the database.
