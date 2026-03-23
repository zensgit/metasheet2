# Overnight Shift Verification

Date: 2026-03-23

## Code Changes Verified

- `AttendanceShift` now includes `isOvernight`.
- The shift form includes `isOvernight`.
- Shift save payloads include `isOvernight`.
- Edit flows preserve the overnight flag.
- Shift list rendering includes a schedule summary and an overnight indicator.
- `attendance_shifts` now persists `is_overnight`.
- Shift create/update accepts legacy aliases such as `start_time`, `end_time`, `is_overnight`, and `working_days`.
- Assignment-embedded shift payloads expose the overnight flag.
- Attendance metrics now anchor overnight shift end thresholds to the next calendar day.
- Persisted shift times in `HH:MM:SS` form are normalized correctly before overnight metric calculation.
- Shift create and update now share one timing validator, so overnight contract checks are no longer duplicated across routes.
- Generated OpenAPI dist artifacts are synced to the overnight shift schema changes.

## Validation Rules

- Start and end times cannot be identical.
- If `isOvernight` is `false`, `workStartTime` must be earlier than `workEndTime`.
- If `isOvernight` is `true`, `workStartTime > workEndTime` is accepted.
- If the payload omits the overnight flag, the backend infers it from `workStartTime > workEndTime`.
- Contradictory payloads are rejected instead of silently normalizing to defaults.

## Test Coverage

- `useAttendanceAdminScheduling.spec.ts`
  - saves a normal shift with `isOvernight: false`
  - allows overnight shift submission with `isOvernight: true`
  - rejects overnight-looking times when the flag is disabled
- `AttendanceSchedulingAdminSection.spec.ts`
  - renders the overnight toggle
  - renders the overnight schedule summary
- `attendance-plugin.test.ts`
  - creates overnight shifts through legacy API aliases
  - returns `isOvernight` on shift lookup
  - computes overnight records without false late/early penalties

## Commands Run

```bash
pnpm --filter @metasheet/web exec vitest run tests/useAttendanceAdminScheduling.spec.ts tests/AttendanceSchedulingAdminSection.spec.ts --watch=false
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts -t "supports shift and overtime rule lookup by id and rejects malformed ids with 400|keeps camelCase and snake_case field aliases on shift and assignment responses|computes overnight shift metrics against the next-day shift end window|accepts legacy snake_case payload aliases for attendance admin create routes and rejects malformed ids with 400|exposes workday context for holiday overrides and shift schedules on attendance records"
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/core-backend exec tsc --noEmit
pnpm --filter @metasheet/web build
./scripts/ops/attendance-run-gate-contract-case.sh openapi
```

## Result

- 2 test files passed
- 24 tests passed
- 1 targeted backend integration file passed
- 5 targeted backend integration tests passed
- `vue-tsc --noEmit` passed
- `tsc --noEmit` passed
- `apps/web build` passed
- `attendance-run-gate-contract-case.sh openapi` passed after syncing generated dist artifacts

## Notes

- This pass keeps the attendance record keyed by the existing `workDate`; no storage redesign was required.
- The local persistent test database had stale migration history, so local verification required a one-off `attendance_shifts.is_overnight` column patch before rerunning the overnight-targeted integration subset. The repository still carries the formal migration file for normal environments.
- The next likely follow-up is a dedicated API-level CSV template endpoint if external clients need file downloads without going through the web UI.
