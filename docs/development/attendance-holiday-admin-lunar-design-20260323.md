# Attendance Holiday Admin Lunar Design 2026-03-23

## Background

The attendance overview calendar already shows lunar labels for Chinese locale users, but the holiday calendar inside the admin center only renders day numbers and holiday chips. This creates a visible inconsistency between the overview experience and the holiday management experience.

The target for this change is narrow: keep the existing holiday-management layout and behavior, but make each day cell in the admin holiday calendar display the same lunar day hint that users already see in the overview calendar.

## Design

### Scope

- Add lunar labels to the holiday calendar inside `AttendanceHolidayDataSection.vue`.
- Reuse the existing calendar utility used by the overview calendar instead of reimplementing lunar formatting.
- Only enable lunar rendering when the attendance page is already in Chinese mode.

### Implementation choices

1. Reuse `formatLunarDayLabel()` from `apps/web/src/views/attendanceCalendarUtils.ts`.
2. Add an optional `showLunarCalendar` prop to `AttendanceHolidayDataSection.vue`.
3. Pass `isZh` from `AttendanceView.vue` into `AttendanceHolidayDataSection.vue`, so the child component follows the same locale-driven rule as the overview calendar.
4. Render the lunar label between the day number and holiday chips, preserving the current holiday chips and selection styles.

### Non-goals

- Do not change holiday CRUD behavior.
- Do not change month navigation behavior.
- Do not introduce a separate locale detector inside the admin holiday component.
- Do not alter the overview calendar implementation beyond passing the locale flag down to the admin section.

## Files

- `apps/web/src/views/attendance/AttendanceHolidayDataSection.vue`
- `apps/web/src/views/AttendanceView.vue`
- `apps/web/tests/AttendanceHolidayDataSection.spec.ts`

