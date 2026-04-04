# Attendance Reports Time Slice Design

Date: 2026-04-04

## Scope

Implement the second `Reports 2.0` slice for attendance as a frontend-only enhancement on top of the already separated reports surface.

Files intentionally kept inside the attendance frontend:

- `apps/web/src/views/AttendanceView.vue`
- `apps/web/tests/attendance-reports-analytics.spec.ts`

No approval-center files or backend routes are changed in this slice.

## Problem

After `#627`, the reports page already had:

- snapshot cards
- request filters
- record status filters

But it still lacked a stronger time-oriented reporting workflow:

- no quick range presets
- no clear range label
- no summary/trend cards grounded in the selected date range
- export scope was still easy to misunderstand

## Goals

1. Make report usage faster with one-click date presets.
2. Surface range-level attendance trend data without adding backend work.
3. Clarify what report export does versus what local filters do.

## Changes

### 1. Add report period presets

Add `This week / This month / Last month / This quarter` buttons in reports mode.

Selecting a preset:

- updates `fromDate` and `toDate`
- resets records pagination
- reloads report data

### 2. Add range-driven analytics cards

Use already loaded `summary` data to render:

- `Attendance Trend`
- `Management Metrics`

This gives the reports surface a true time-range layer instead of relying only on request and record tables.

### 3. Clarify export scope

Add a report-period label and a scoped note that explains:

- server-side date/org/user filters affect export
- local filter pills only affect visible rows in the current page

### 4. Fix local date formatting for presets

The existing `toDateInput()` used `toISOString().slice(0, 10)`, which can shift dates backward in positive-offset time zones when the source date is local midnight.

This slice changes date-input formatting to local calendar components so report presets do not drift by one day.

## Non-goals

- No backend contract changes
- No approval workflow changes
- No new route/view split
- No export format changes

## Follow-up

Possible next slices:

- compare this period vs previous period
- manager-focused trend deltas
- saved report presets
- export presets that align with the local report pills
