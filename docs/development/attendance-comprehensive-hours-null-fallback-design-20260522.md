# Attendance Comprehensive Hours Null Fallback Design

Date: 2026-05-22
Branch: `codex/attendance-comprehensive-hours-null-fallback-20260522`

## Summary

This follow-up hardens the pure comprehensive-hours PR1 helpers after review of
`#1770`. The planned-minutes helper accepted explicit per-day overrides, but
`null` and empty-string values were normalized with `Number(...)`, which turned
them into `0`. That made a missing/blank override suppress normal shift-duration
calculation.

The fix keeps the same public helper surface and changes only the optional
override normalization:

- `undefined`, `null`, and blank strings mean "no explicit override"
- finite numeric values still become non-negative integer minutes
- invalid non-numeric values also fall back to shift-derived planned minutes

## Why This Matters

Future preview routes will likely read day-like rows from DB/query producers
where nullable columns are common. A `plannedMinutes: null` value should not make
a working day appear to have 0 planned minutes. Only a real explicit `0` should
mean zero planned minutes.

## Scope

| Area | Decision |
| --- | --- |
| Runtime route | Not added. |
| UI | Not changed. |
| DB migration | Not added. |
| Attendance writes | Not added. |
| Save warning / blocking | Not added. |
| Helper API | Preserved. |

## Implementation

Added `normalizeAttendanceComprehensiveOptionalMinutes(...)` and routed day-level
`plannedMinutes` / `planned_minutes` through it before falling back to
`calculateAttendanceComprehensiveShiftPlannedMinutes(profile)`.

The helper deliberately treats explicit numeric `0` as an override, while
`null` and `''` are absence signals.
