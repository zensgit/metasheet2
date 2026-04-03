# Attendance Request Record Settlement Design

## Context

Product-side verification reported that a `missed_check_in` request could be approved while no attendance record was visible afterward. Current runtime code in `plugin-attendance` already attempts to settle `attendance_records` during final approval, so the next step was to verify that behavior with a focused integration instead of adding new product logic blindly.

## Scope

- Add a focused backend integration that exercises:
  - shift creation
  - shift assignment
  - approval flow creation
  - `missed_check_in` request creation
  - final approval
  - record lookup through `/api/attendance/records`
- Lock the expected outcome that final approval writes an `adjusted` record with the requested check-in timestamp.

## Non-Goals

- No runtime behavior changes in `plugin-attendance`
- No changes to request workflow semantics
- No changes to workday/holiday resolution rules

## Decision

Treat this slice as a regression-proof verification of current behavior. If the focused integration failed, it would justify a runtime hotfix. If it passed, the user-visible gap should be treated as an environment, query-condition, or product-semantics follow-up rather than a missing settlement implementation.

