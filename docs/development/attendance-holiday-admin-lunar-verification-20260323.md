# Attendance Holiday Admin Lunar Verification 2026-03-23

## Verified behavior

- The admin holiday calendar now renders a lunar label in each day cell when lunar display is enabled.
- The admin holiday calendar keeps existing day selection and month navigation behavior.
- The feature is wired from the same `isZh` locale state used by the overview calendar.

## Commands run

```bash
pnpm --filter @metasheet/web exec vitest run tests/AttendanceHolidayDataSection.spec.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/attendance-calendar-utils.spec.ts tests/AttendanceHolidayDataSection.spec.ts --watch=false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
```

## Results

- `tests/AttendanceHolidayDataSection.spec.ts`: passed (`3 tests`)
- `tests/attendance-calendar-utils.spec.ts` + `tests/AttendanceHolidayDataSection.spec.ts`: passed (`9 tests`)
- `vue-tsc --noEmit`: passed
- `apps/web build`: passed

## Notes

- This change intentionally reuses the existing lunar formatter so the overview calendar and the admin holiday calendar stay aligned.
- The build still emits the pre-existing Vite chunk-size warning; this change does not affect that warning.

