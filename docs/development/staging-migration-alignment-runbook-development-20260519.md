# Staging Migration Alignment Runbook Development

Date: 2026-05-19

## Summary

This slice turns the previous attendance staging migration audit into a reusable
read-only operator tool and updates the staging migration runbook to require the
tool before any alignment action.

The implementation is intentionally non-mutating:

- no DB connection is opened by the new script;
- no migration is executed;
- no `kysely_migration` row is written;
- no staging/prod secret is read;
- output goes under `output/` and is not committed.

## Files

| File | Change |
| --- | --- |
| `scripts/ops/staging-migration-alignment-report.mjs` | New read-only parser/classifier for `migrate --list` output. |
| `scripts/ops/staging-migration-alignment-report.test.mjs` | Unit tests for staging-style pending list, non-idempotent SQL detection, aligned state, and missing input. |
| `docs/operations/staging-migration-alignment-runbook.md` | Adds a 2026-05-20 safety update requiring the report before Option A or full migrate. |
| `docs/development/staging-migration-alignment-runbook-development-20260519.md` | This development record. |
| `docs/development/staging-migration-alignment-runbook-verification-20260519.md` | Verification record. |

## Script Contract

Input options:

```bash
node scripts/ops/staging-migration-alignment-report.mjs \
  --migrate-list-file <file> \
  --out-dir output/staging-migration-alignment-report/<run>
```

or:

```bash
node scripts/ops/staging-migration-alignment-report.mjs --run-list
```

or stdin:

```bash
pnpm --filter @metasheet/core-backend exec tsx src/db/migrate.ts --list \
  | node scripts/ops/staging-migration-alignment-report.mjs
```

Output:

- `report.json`
- `report.md`

The script parses:

- `Applied: N`
- `Pending: N`
- pending migration names under `Pending migrations (in load order):`

It reads the local migration provider to classify superseded legacy SQL names
instead of hard-coding the `032` through `055` range manually.

## Classification

| Category | Rule |
| --- | --- |
| `superseded_legacy_noop_marker` | Name appears in `SUPERSEDED_LEGACY_SQL_MIGRATIONS`. |
| `legacy_executable_sql` | Name starts with a numeric legacy prefix and is not superseded. |
| `timestamp_sql` | Name starts with an 8-digit timestamp prefix. |
| `modern_timestamp_migration` | Name starts with `zzzz`. |
| `other` | Fallback for unexpected names. |

## Risk Heuristics

| Risk | Rule |
| --- | --- |
| `ledger_review` | Superseded legacy no-op marker; requires ledger/schema review but does not imply DDL replay. |
| `high` | Local migration up path contains `CREATE TABLE` without `IF NOT EXISTS`, Kysely `.createTable()` without `.ifNotExists()`, or a `DROP` statement. |
| `medium` | Legacy/timestamp SQL, or unguarded-looking `ALTER TABLE`. |
| `low` | No obvious replay risk detected by static scan. |
| `unknown` | Local migration file was not found. |

For TypeScript migrations, the static scan only examines the `up()` body. A
rollback-only `down()` `DROP TABLE` is not treated as a replay risk for applying
pending migrations.

## Decision Heuristic

| Decision | Meaning |
| --- | --- |
| `aligned` | `Pending: 0`; no action needed. |
| `do_not_run_full_migrate` | At least one high-risk pending migration exists. Rehearse on clone/backup first. |
| `rehearse_before_migrate` | Pending executable migrations exist but no high-risk static signal was found. |
| `ledger_review_only` | Only superseded no-op marker names are pending. |

## Boundaries

- The script is a report generator, not a migration runner.
- The script does not classify a migration as safe to replay based only on name.
- The runbook now explicitly blocks blind synthetic catch-up when the report says `do_not_run_full_migrate`.
- Claude is not needed for development; independent review is appropriate after PR creation.
