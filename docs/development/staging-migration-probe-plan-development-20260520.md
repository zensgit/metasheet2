# Staging Migration Probe Plan Development

Date: 2026-05-20

## Summary

This slice extends the read-only staging migration alignment report with a
schema probe plan. The goal is to turn a pending migration list into an
operator-friendly rehearsal checklist without connecting to the database or
executing migrations.

The probe plan is deliberately conservative:

- it only scans migration `up()` paths;
- it extracts obvious static table, column, and index targets;
- it treats complex or dynamic DDL as manual review work;
- it does not classify a migration as safe to replay.

## Files

| File | Change |
| --- | --- |
| `scripts/ops/staging-migration-alignment-report.mjs` | Adds schema target extraction and a `schemaProbePlan` section to JSON/Markdown output. |
| `scripts/ops/staging-migration-alignment-report.test.mjs` | Adds regression tests for SQL table/column probes, Kysely create-table probes, down-path boundaries, and same-statement alter-column extraction. |
| `docs/operations/staging-migration-alignment-runbook.md` | Documents how operators should use the new Schema Probe Plan section. |
| `docs/development/staging-migration-probe-plan-development-20260520.md` | This design/development record. |
| `docs/development/staging-migration-probe-plan-verification-20260520.md` | Verification record for this slice. |

## Extraction Rules

| Target | Supported static patterns |
| --- | --- |
| Tables | SQL `CREATE TABLE`, SQL `ALTER TABLE`, Kysely `.createTable('...')`, Kysely `.alterTable('...')`. |
| Columns | SQL `CREATE TABLE (...)` top-level column declarations, SQL `ALTER TABLE ... ADD COLUMN ...`, Kysely `.addColumn('...')` inside static create/alter chains. |
| Indexes | SQL `CREATE INDEX ... ON ...`, Kysely `.createIndex('...').on('...')`. |

The extractor strips comments before scanning. For TypeScript migrations, it
first narrows the scan to `up()` and ignores rollback-only `down()` DDL.

## Guardrails

- The script remains a report generator, not a migration runner.
- No DB connection is opened.
- No `kysely_migration` row is written.
- No staging/prod secret is read.
- Local `output/` evidence is intentionally untracked.
- The Markdown report explains that the Schema Probe Plan is a checklist, not a
  safety proof.

## Operator Value

Before this slice, operators saw that staging had `Applied: 86 / Pending: 77`
and a risk bucket summary. After this slice, they also get a first-pass list of
objects to inspect on a rehearsal database, such as:

- pending plugin infrastructure tables;
- audit tables and partitions;
- approval template tables, altered columns, and indexes;
- the already-aligned report sync job operational table.

This makes the next rehearsal step more mechanical while keeping the current
production/staging databases untouched.
