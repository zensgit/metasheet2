# Attendance Comprehensive Working Hours Control PR1 Development

Date: 2026-05-22
Branch: `codex/attendance-comprehensive-hours-pr1-20260522`

## Summary

This slice implements PR1 from `attendance-comprehensive-hours-control-rfc-20260522.md`: pure calculator helpers for comprehensive working-hours control (`综合工时制`). It deliberately does not add a route, UI, policy storage, migration, save warning, or save block.

The helpers define the semantics that later preview and enforcement PRs will reuse:

- deterministic period resolution
- planned scheduled minutes from effective-calendar / schedule-day inputs
- actual attendance minutes from summary payloads
- cap comparison for warn vs block policy modes
- stable per-user preview rows

## Changed Files

| File | Change |
| --- | --- |
| `plugins/plugin-attendance/index.cjs` | Adds pure comprehensive-hours helper functions and exports them through the existing test surface. |
| `packages/core-backend/tests/unit/attendance-comprehensive-hours-control.test.ts` | Adds unit coverage for period resolution, invalid input, planned-vs-actual separation, cap comparison, and stable preview rows. |
| `docs/development/attendance-comprehensive-hours-control-pr1-development-20260522.md` | This development note. |
| `docs/development/attendance-comprehensive-hours-control-pr1-verification-20260522.md` | Verification evidence. |

## Helper Contract

| Helper | Contract |
| --- | --- |
| `resolveAttendanceComprehensiveHoursPeriod(input, options?)` | Resolves `month`, `quarter`, `year`, `custom_range`, and `payroll_cycle` to `{ type, key, from, to, label }`; returns `{ ok:false,error }` instead of throwing for invalid input. |
| `calculateAttendanceComprehensiveShiftPlannedMinutes(profile)` | Computes shift duration from `workStartTime` / `workEndTime` and `isOvernight`; returns 0 for invalid times. |
| `buildAttendanceComprehensivePlannedMinutesFromDays(days, options?)` | Aggregates planned minutes from effective-calendar-style day rows without reading actual attendance summaries. |
| `buildAttendanceComprehensiveActualMinutesFromSummary(summary)` | Extracts actual minutes from existing summary payload fields such as `total_minutes` / `work_duration`. |
| `buildAttendanceComprehensiveHoursComparison(input)` | Computes `remainingMinutes`, `excessMinutes`, and `status: ok | warning | violation`. |
| `buildAttendanceComprehensiveHoursPreviewRows(input)` | Produces stable user-sorted comparison rows and switches planned vs actual source by `metric`. |

## Boundary

| Boundary | Decision |
| --- | --- |
| HTTP route | Not added. |
| Frontend UI | Not added. |
| Policy persistence | Not added. |
| New migration | Not added. |
| `attendance_*` fact writes | Not added. |
| Direct `meta_*` writes | Not added. |
| Multitable writes | Not added. |
| Advanced scheduling write path | Not touched. |
| Save warning / save block | Not added. |
| Data Factory / Bridge Agent | Not touched. |

## Design Notes

### Planned and Actual Stay Separate

`buildAttendanceComprehensivePlannedMinutesFromDays()` consumes schedule/effective-calendar day rows. `buildAttendanceComprehensiveActualMinutesFromSummary()` consumes existing attendance summary payloads. They are intentionally separate helpers so a future preview route cannot accidentally use actual attendance data to block future schedule saves.

### Invalid Input Does Not Throw

The period resolver returns structured errors. This makes the future PR2 route able to map validation failures to 400 responses without adding another parser shape.

### Strong Control Is Only a Status

This PR can compute `status='violation'` when `enforcement='block'`, but it does not enforce or block anything. Enforcement belongs to a later explicit opt-in PR.

## Follow-Up

Next slice should be PR2: a read-only `POST /api/attendance/comprehensive-hours/preview` route that wires these helpers to database producers. That PR should request independent review before merge.
