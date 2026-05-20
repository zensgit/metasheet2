# Attendance Holidays Origin Sync Protection Verification

Date: 2026-05-20
Branch: `runtime/attendance-holidays-origin-sync-protection-20260520`
Base: `origin/main@3e76aa7c6`
Commit: branch tip `feat(attendance): protect manual holidays during sync`

## Definition of Done

This slice is merge-ready only when the DB-backed test below is executed against a real PostgreSQL database and prints the concrete test case name:

```text
✓ tests/integration/attendance-plugin.test.ts > Attendance Plugin Integration > protects manual holiday origins during national holiday sync
```

That gate is now satisfied on scratch PostgreSQL 15.17.

## Summary

Step 2 is implemented locally and passes non-DB validation plus the DB-backed holiday sync regression on scratch PostgreSQL.

## Commands Run

| Command | Result |
| --- | --- |
| `pnpm --filter @metasheet/core-backend test:unit` | PASS: 170 files / 2245 tests. |
| `pnpm --filter @metasheet/core-backend build` | PASS. |
| `pnpm --filter @metasheet/core-backend exec tsc -p tsconfig.json --noEmit` | PASS. |
| `node --check plugins/plugin-attendance/index.cjs` | PASS. |
| `ATTENDANCE_TEST_DATABASE_URL=postgresql://127.0.0.1:5432/<scratch-db> DATABASE_URL=postgresql://127.0.0.1:5432/<scratch-db> pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts -t "protects manual holiday origins" --reporter=verbose` | PASS on scratch PostgreSQL: concrete target test executed and passed. |
| `git diff --check` | PASS. |
| `psql ... information_schema / pg_constraint probe` | PASS: `origin` is `text not null default 'manual'::text`; `attendance_holidays_origin_check` allows `national/manual`. |

## Environment Checks

```text
PostgreSQL: 15.17 (Homebrew)
Scratch DB: metasheet_att_origin_sync_20260519193942
Migration: zzzz20260520020000_add_origin_to_attendance_holidays executed successfully
```

Target test output:

```text
✓ tests/integration/attendance-plugin.test.ts > Attendance Plugin Integration > protects manual holiday origins during national holiday sync

Test Files  1 passed (1)
Tests  1 passed | 66 skipped (67)
Duration  2.82s
```

Schema probe:

```text
origin|text|'manual'::text|NO
attendance_holidays_origin_check|CHECK ((origin = ANY (ARRAY['national'::text, 'manual'::text])))
```

## Regression Matrix

The added integration test `protects manual holiday origins during national holiday sync` covers the RFC Step 2 matrix when run with a real DB:

| Case | Covered by test assertion |
| --- | --- |
| Empty table sync | `Synced Empty` is inserted as `origin = 'national'`. |
| National row update | Existing national row updates name/workday and remains `origin = 'national'`. |
| Manual row conflict | Existing manual row remains unchanged and increments `totalIgnored`. |
| Manual deleted then sync | Deleted manual date is re-created as `origin = 'national'`. |
| `overwrite = false` | Existing national row remains unchanged and increments `totalSkipped`. |
| Backfill/default | Insert without `origin` defaults to manual and is protected from sync. |

Expected counters in the DB-backed test:

| Sync mode | totalFetched | totalApplied | totalIgnored | totalSkipped |
| --- | ---: | ---: | ---: | ---: |
| `overwrite = true` | 5 | 3 | 2 | 0 |
| `overwrite = false` | 1 | 0 | 0 | 1 |

## Static Evidence

- Migration adds/drops `attendance_holidays_origin_check` and the `origin` column.
- Sync writer inserts `origin = 'national'`.
- Sync writer updates only when `attendance_holidays.origin = 'national'`.
- Admin create inserts `origin = 'manual'`.
- Holiday list/detail/update queries return `origin`.
- Sync response and `holidaySync.lastRun` expose `totalSkipped` and `totalIgnored`.

## Remaining Gate

No DB gate remains for this slice. The scratch PostgreSQL target test above executed the manual protection and counter assertions against real Postgres.

If the branch is rebased again before PR, rerun:

```bash
ATTENDANCE_TEST_DATABASE_URL=postgres://... \
  pnpm --filter @metasheet/core-backend exec vitest \
  --config vitest.integration.config.ts \
  run tests/integration/attendance-plugin.test.ts \
  -t "protects manual holiday origins" \
  --reporter=dot
```
