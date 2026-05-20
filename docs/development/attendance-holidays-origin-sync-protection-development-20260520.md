# Attendance Holidays Origin Sync Protection Development

Date: 2026-05-20
Branch: `runtime/attendance-holidays-origin-sync-protection-20260520`
Base: `origin/main@3e76aa7c6`
Commit: branch tip `feat(attendance): protect manual holidays during sync`
RFC: `docs/development/attendance-effective-calendar-rfc-20260520.md`

## Goal

Implement Step 2 of the Attendance Effective Calendar RFC:

- add a base-layer origin marker to `attendance_holidays`;
- make national holiday sync write only `origin = 'national'` rows;
- protect admin/manual holiday rows from sync overwrite;
- expose applied/skipped/ignored sync counters;
- add a DB-backed regression test for the sync matrix.

This slice does not implement `settings.calendarPolicy`, the effective-calendar resolver, frontend calendar consumption, or calc-chain cutover.

## Changed Files

| File | Change |
| --- | --- |
| `packages/core-backend/src/db/migrations/zzzz20260520020000_add_origin_to_attendance_holidays.ts` | Adds `attendance_holidays.origin text not null default 'manual'` plus `national/manual` check constraint; down migration drops the constraint and column. |
| `packages/core-backend/src/db/types.ts` | Adds `origin: 'national' \| 'manual'` to `AttendanceHolidaysTable`. |
| `plugins/plugin-attendance/index.cjs` | Maps holiday row origin, writes admin-created holidays as manual, writes sync holidays as national, pre-classifies manual conflicts, and returns/applies sync counters. |
| `packages/core-backend/tests/integration/attendance-plugin.test.ts` | Adds a DB-backed integration test covering manual protection and sync counter semantics. |

## Runtime Semantics

`attendance_holidays` remains one row per `(org_id, holiday_date)`.

`origin` means:

- `national`: row was created or updated by `/api/attendance/holidays/sync`;
- `manual`: row was created by an admin or existed before this migration.

Admin create/update/delete remains the manual holiday management surface. Sync cannot downgrade a manual row to national.

## Sync Algorithm

`upsertHolidayRows()` now returns:

```ts
{
  applied: number
  skipped: number
  ignored: number
}
```

For each sync chunk:

1. Pre-pass query existing rows by date:
   ```sql
   SELECT holiday_date, COALESCE(origin, 'manual') AS origin
   FROM attendance_holidays
   WHERE org_id = $1 AND holiday_date = ANY($2::date[])
   ```
2. Classify existing `manual` conflicts as `ignored`.
3. When `overwrite = false`, classify existing non-manual rows as `skipped`.
4. Insert/update remaining rows as `origin = 'national'`.
5. Count SQL `RETURNING` rows as `applied`.
6. Treat race-time non-applied rows as `ignored` for overwrite mode and `skipped` for no-overwrite mode.

The sync response, per-year `results[]`, auto-sync event payload, logs, and `holidaySync.lastRun` now include `totalSkipped` and `totalIgnored` next to the existing fetched/applied counters.

## Scope Boundaries

Implemented:

- migration and type shape for `origin`;
- sync writer protection for national/manual rows;
- admin CRUD compatibility;
- sync response counter compatibility;
- DB-required regression test for the Step 2 sync matrix.

Not implemented:

- `settings.calendarPolicy.overrides[]`;
- shared `matchScopeFilters`;
- `/api/attendance/effective-calendar`;
- frontend layer-chain tooltip or calendar source colors;
- `resolveWorkContext` / payroll / import cutover.

## Risk Notes

- The migration defaults existing rows to `manual`, matching the RFC backfill policy.
- Sync uses a pre-pass query because SQL `RETURNING` alone cannot distinguish manual conflicts from skipped no-overwrite rows.
- The new integration test requires a real PostgreSQL URL. Without `DATABASE_URL` or `ATTENDANCE_TEST_DATABASE_URL`, the existing integration harness returns early, so local "passed" output is only a load check.
