# Attendance Group Fixed-Schedule Provenance FS-D2 Verification - 2026-05-28

## Scope

FS-D2 starts populating provenance metadata for rows newly created by the attendance-group fixed-schedule apply route.

This follows:

- `attendance-group-admin-ux-fixed-schedule-managed-provenance-design-20260528.md`
- `attendance-group-admin-ux-fixed-schedule-provenance-fsd1-verification-20260528.md`

## Delivered Behavior

Newly inserted `attendance_shift_assignments` rows from group fixed-schedule apply now carry:

- `producer_type = attendance_group_fixed_schedule`
- `producer_ref_id = groupId`
- `producer_key = attendance_group_fixed_schedule:{groupId}:{shiftId}:{startDate}:{endDate-or-null}`
- `producer_run_id = one UUID shared across all rows created by the same apply run`

The existing FS-C preview/apply classifier remains the source of truth:

- exact active matches stay `skipped`;
- overlapping non-exact rows stay `blockingConflicts`;
- only `wouldCreate[]` rows are inserted and tagged.

## Boundaries Held

- No migration: FS-D1 already added the nullable columns.
- No route or API shape change beyond returned assignment rows now reflecting populated metadata.
- No UI change.
- No rebuild/clear operation.
- No soft-deactivation.
- No claiming or mutating existing exact-match rows.
- No second schedule fact table.

## Verification

Commands run:

```bash
node --check plugins/plugin-attendance/index.cjs
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-scheduling-assignment-conflict.test.ts --watch=false
```

Results:

- `node --check`: PASS
- `attendance-scheduling-assignment-conflict.test.ts`: PASS, 14/14

New/updated assertions:

- stable finite-window and open-ended `producer_key` helper output;
- apply insert SQL includes all four producer columns;
- inserted rows map back with populated `producerType`, `producerRefId`, `producerKey`, and `producerRunId`;
- one apply run reuses a single `producer_run_id` across multiple created rows;
- exact-match skipped rows are not updated or retroactively claimed;
- open-ended schedules use `...:{startDate}:null` in the producer key;
- blocking conflicts still produce zero inserts.

## Deferred

FS-D3 remains separate: managed rebuild/clear and soft-deactivation by `producer_key` are not implemented here.
