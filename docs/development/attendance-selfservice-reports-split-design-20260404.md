# Attendance Self-Service Reports Split Design

## Context

The attendance experience shell already exposed separate `Overview` and `Reports` tabs, but the reports tab still reused the overview surface shape. That left employee self-service feeling duplicated instead of intentionally split.

At the same time, approval-center work is happening in another thread, so this slice must stay inside attendance self-service surfaces and avoid approval route or inbox ownership.

## Decision

Split the attendance employee-facing experience into two clearer surfaces:

1. `Overview`
   - keeps the operational workbench
   - summary
   - calendar
   - request submission + recent requests
   - anomalies
2. `Reports`
   - keeps the analytical surface
   - request report
   - records table
   - export actions

## Changes

1. `AttendanceReportsView.vue` now supports `initialSectionId` just like the overview and admin wrappers.
2. `AttendanceView.vue` keeps `mode="reports"` as a true reports surface:
   - reports header copy is report-specific
   - reports header shows lightweight KPI chips for records / requests / minutes
   - request report is no longer rendered on the overview workbench
   - records are no longer rendered on the overview workbench
   - reports refresh now reloads both request report data and records
3. Wrapper and shell tests were updated so the reports tab stays wired to a dedicated reports view instead of falling back to overview semantics.

## Non-goals

- No changes to approval-center views or approval routes.
- No backend contract changes.
- No new attendance admin surface changes.
