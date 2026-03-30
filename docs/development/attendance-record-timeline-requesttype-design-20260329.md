# Attendance Record Timeline Request Type Design

## Goal

Make the record-timeline request bridge smarter without expanding scope beyond the existing request form.

The previous bridge slice always prefills `time_correction`. That is safe, but it still leaves obvious single-sided punch gaps under-optimized:

- only `check_in` present
- only `check_out` present

This slice infers the narrowest correct request type from the loaded raw punch timeline.

## Scope

1. Keep the feature inside the existing record timeline bridge.
2. Infer request type from the loaded punch-event mix.
3. Leave the missing side blank when the inferred request type is a single-sided correction.
4. Keep `time_correction` for two-sided or ambiguous cases.

## Design

### 1. Small deterministic inference rule

The inference is intentionally simple:

- `check_in` only -> `missed_check_out`
- `check_out` only -> `missed_check_in`
- both or ambiguous -> `time_correction`

This avoids heuristic overreach while still removing the most common manual form toggle.

### 2. Missing-side fields stay empty

When the inferred request type is one-sided, the bridge must not backfill the missing side from the summary record row.

Otherwise the form would say “missed check-out” while still pre-populating a `requestedOutAt`, which is semantically wrong.

### 3. Keep fallback behavior for two-sided correction

For `time_correction`, the bridge may still fall back to the summary row's `first_in_at / last_out_at` when the raw event list is incomplete.

That preserves the previous convenience for the general correction case.

## Non-goals

- No backend changes
- No anomaly-specific inference
- No auto-submission or approval logic
- No new request types
