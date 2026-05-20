# Staging Migration Probe Plan Verification

Date: 2026-05-20

## Scope

Verify the schema probe plan extension for the read-only staging migration
alignment report.

No staging DB migration was executed. No `kysely_migration` row was written.

## Checks

| Check | Result |
| --- | --- |
| `node --check scripts/ops/staging-migration-alignment-report.mjs` | PASS |
| `node --test scripts/ops/staging-migration-alignment-report.test.mjs` | PASS, 6 tests |
| `git diff --check` | PASS |
| Live staging read-only report generation | PASS |

## Unit Coverage

The test suite now locks:

- staging-style pending classification still returns
  `decision=do_not_run_full_migrate`;
- non-idempotent SQL `CREATE TABLE` is still high risk;
- SQL table and column probes are emitted for `20250926_create_audit_tables`;
- partition child tables do not receive fake copied column probes;
- TypeScript `down()` drops are ignored for replay risk and probe extraction;
- Kysely `.createTable().addColumn()` chains emit table, column, and index
  targets for `zzzz20260519070000_create_plugin_attendance_report_sync_jobs`;
- SQL `ALTER TABLE ... ADD COLUMN ...` probes stay within the same statement,
  preventing cross-statement column misattribution.

## Live Staging Read-Only Report

Generated from 8082 staging `migrate --list` output on 2026-05-20 without
executing migrations:

| Metric | Value |
| --- | --- |
| Applied migrations | 86 |
| Pending migrations | 77 |
| Decision | `do_not_run_full_migrate` |
| Probe plan entries | 76 |

Risk counts:

| Risk | Count |
| --- | --- |
| `high` | 12 |
| `ledger_review` | 29 |
| `medium` | 5 |
| `low` | 31 |

The generated report was written under local untracked `output/` and is not
committed.

## Boundary Verification

- No token/JWT paths were used or committed.
- The script still supports file/stdin/`--run-list` inputs only.
- The live staging step only captured `migrate --list` output.
- The schema probe plan is static analysis output and does not query staging
  schema directly.
