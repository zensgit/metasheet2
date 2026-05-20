# Staging Migration Alignment Runbook Verification

Date: 2026-05-19

## Scope

Verify the read-only staging migration alignment report script and runbook
update.

No staging DB migration was executed.

## Checks

| Check | Result |
| --- | --- |
| `node --check scripts/ops/staging-migration-alignment-report.mjs` | PASS |
| `node --test scripts/ops/staging-migration-alignment-report.test.mjs` | PASS |
| Fixture: staging-style pending list classification | PASS |
| Fixture: no pending migrations returns `aligned` | PASS |
| Fixture: no input fails clearly | PASS |
| Static scan: `20250926_create_audit_tables` flagged high risk | PASS |
| Static scan: TypeScript `down()` drops are ignored for replay risk | PASS |
| Live staging read-only report generation | PASS |
| `git diff --check` | PASS |

## Test Evidence

The staging-style fixture intentionally mirrors the 2026-05-19 audit shape:

- `Applied: 86`
- `Pending: 77`
- 29 superseded legacy no-op marker names
- 5 legacy executable SQL names
- 2 timestamp SQL names
- several modern `zzzz` names

The test asserts:

- `fullMigrateRecommended=false`
- `decision=do_not_run_full_migrate`
- `categoryCounts.superseded_legacy_noop_marker=29`
- `categoryCounts.legacy_executable_sql=5`
- `categoryCounts.timestamp_sql=2`

The non-idempotent SQL fixture asserts:

- `20250926_create_audit_tables` is categorized as `timestamp_sql`
- risk is `high`
- `hasCreateTableWithoutIfNotExists=true`

The TypeScript migration fixture asserts:

- `zzzz20260519070000_create_plugin_attendance_report_sync_jobs` is categorized
  as `modern_timestamp_migration`
- `down()` contains rollback DDL but does not make the migration high risk
- `hasDropStatement=false` for the scanned replay path

## Live Staging Read-Only Report

Generated from staging `migrate --list` output on 2026-05-19 without executing
any migration:

| Metric | Value |
| --- | --- |
| Applied migrations | 86 |
| Pending migrations | 77 |
| Parsed pending names | 77 |
| Decision | `do_not_run_full_migrate` |
| Full migrate recommended | `false` |

Category counts:

| Category | Count |
| --- | --- |
| `legacy_executable_sql` | 5 |
| `superseded_legacy_noop_marker` | 29 |
| `timestamp_sql` | 2 |
| `modern_timestamp_migration` | 41 |

Risk counts after the `up()`-only scan fix:

| Risk | Count |
| --- | --- |
| `high` | 12 |
| `ledger_review` | 29 |
| `medium` | 5 |
| `low` | 31 |

The report output was written under local untracked `output/` for operator
review and is intentionally not committed.

## Boundary Verification

- No token/JWT paths are used or committed.
- No `DATABASE_URL` is required for fixture mode.
- No DB write path exists in the new script.
- The runbook update only adds a safety pre-step; it does not remove the historical runbook content.

## Recommended Operator Use

For staging:

```bash
docker compose -f docker-compose.app.staging.yml exec -T backend \
  node packages/core-backend/dist/src/db/migrate.js --list \
  > /tmp/staging-migrate-list.txt

node scripts/ops/staging-migration-alignment-report.mjs \
  --migrate-list-file /tmp/staging-migrate-list.txt \
  --out-dir output/staging-migration-alignment-report/<run>
```

Then read `report.md`. If the decision is `do_not_run_full_migrate`, rehearse
against a DB clone or backup before running migrations or editing
`kysely_migration`.
