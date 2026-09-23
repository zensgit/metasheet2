# Attendance overview timezone label and holiday quick-add copy verification

Date: 2026-09-23
Branch: `cursor/attendance-display-copy-5962-5979-e61e`
Design: `docs/development/attendance-overview-timezone-and-holiday-quick-add-copy-design-20260923.md`
PR: https://github.com/zensgit/metasheet2/pull/6028

## What was checked

- #5962: a recognized rule timezone on the overview work window uses `formatTimezoneLabel` (`UTC+08:00 · Asia/Shanghai`, `UTC+00:00 · UTC`). The mounted overview rules card shows `09:00-18:00 · UTC+08:00 · Asia/Shanghai`, and the same page shows that token on the summary, calendar, request, and anomaly hints. The raw `09:00-18:00 · Asia/Shanghai` form is absent from the rules card. `workWindowShortLabel` / `suggestOffDutyTime` still read the clock range when the offset label adds a second `·`.
- #5979: incomplete quick-add status copy names base rest days and target rest days in English and Chinese. The longer-rest invalid path also names the base rest start date. 「有效天数」 and `valid day counts` are absent. Field labels are unchanged. The holiday-rule section still appends the same override rows.

## Commands

```text
pnpm install --filter @metasheet/web... --frozen-lockfile
pnpm --filter @metasheet/web exec vitest run tests/attendanceEmployeeWorkspacePresentation.spec.ts tests/attendanceCalendarPolicyQuickAdd.spec.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/attendance-selfservice-dashboard.spec.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/useAttendanceHolidayRuleSection.spec.ts --watch=false
```

Results:

```text
✓ tests/attendanceCalendarPolicyQuickAdd.spec.ts  (2 tests)
✓ tests/attendanceEmployeeWorkspacePresentation.spec.ts  (19 tests)
Test Files  2 passed (2)
Tests       21 passed (21)

✓ tests/attendance-selfservice-dashboard.spec.ts  (85 tests)
Test Files  1 passed (1)
Tests       85 passed (85)

✓ tests/useAttendanceHolidayRuleSection.spec.ts  (8 tests)
Test Files  1 passed (1)
Tests       8 passed (8)
```

Vitest 1.6.1, jsdom. The install ignored esbuild/vue-demi build scripts; these specs still ran.

## Not verified

The logged-in attendance overview and admin settings pages were not opened in a browser. These checks render the real Vue components in jsdom, including `AttendanceView` overview mode for the timezone card and hints, and `AttendanceCalendarPolicyQuickAdd` for the status copy.
