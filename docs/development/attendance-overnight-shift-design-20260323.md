# Overnight Shift Design

Date: 2026-03-23

## Goal

Add minimal, usable overnight-shift support end-to-end across attendance scheduling, persistence, and metrics calculation.

## Current Behavior

- Shift forms only modeled same-day schedules.
- The UI rejected `workStartTime > workEndTime`.
- Shift tables did not expose whether a shift was overnight.
- The frontend type model had no explicit overnight flag.
- `attendance_shifts` had no dedicated overnight column.
- Attendance metrics compared `firstInAt` and `lastOutAt` against same-day clock thresholds, which misclassified overnight check-outs as early leave.
- Shift create/update routes ignored common legacy fields like `start_time` and `end_time`.

## Proposed Model

- Add `isOvernight: boolean` to `AttendanceShift`.
- Add `isOvernight: boolean` to the shift form state.
- Persist the flag in shift create/update payloads and in `attendance_shifts.is_overnight`.
- Treat `workStartTime > workEndTime` as valid only when `isOvernight` is enabled.
- Continue rejecting equal start/end times.
- Accept legacy request aliases for shift create/update so API testers do not silently fall back to default times.
- Derive the shift end threshold from `workDate + 1 day` whenever `isOvernight` is enabled.

## UX

- Add a clear overnight checkbox in the shift form.
- Add a schedule summary column in the shift table so users can see the time range at a glance.
- Show an overnight badge or label when the flag is enabled.
- Preserve the existing same-day validation path for standard shifts.

## Backend Semantics

- Add a forward migration that introduces `attendance_shifts.is_overnight boolean not null default false`.
- Backfill `is_overnight = true` for existing shifts whose stored `work_start_time > work_end_time`.
- Expose `isOvernight` and deprecated `is_overnight` in shift responses, assignment-embedded shift payloads, and OpenAPI.
- Update attendance import and record upsert paths so `computeMetrics()` receives `workDate` and evaluates late/early thresholds against the correct calendar window.

## Guardrails

- Normalize missing overnight values to `false` in the UI so older API responses do not break rendering.
- Infer overnight mode from time order only when an explicit flag is missing; reject contradictory payloads such as `isOvernight: false` with `22:00 -> 06:00`.
- Keep execution on the existing attendance record model keyed by `workDate`; do not redesign record storage in this pass.

## Verification Targets

- Shift creation with same-day times remains valid.
- Shift creation with `start > end` fails when overnight is disabled.
- Shift creation with `start > end` succeeds when overnight is enabled.
- Legacy `start_time/end_time/is_overnight` shift payloads create the intended shift instead of falling back to defaults.
- Editing a shift preserves the overnight flag.
- The table summary renders the overnight state clearly.
- Overnight imports compute `lateMinutes` and `earlyLeaveMinutes` against the next-day shift end window.
