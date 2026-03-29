# Attendance Record Timeline Request Bridge Design

## Goal

Turn the new raw punch timeline detail row into an actionable correction path instead of a read-only inspection surface.

After operators inspect a day's raw punches, they should be able to push that context straight into the existing adjustment-request form without manually retyping:

- work date
- inferred first in
- inferred last out

## Scope

1. Keep the feature inside `AttendanceView.vue`.
2. Add one secondary action inside the expanded record timeline row.
3. Prefill the existing request form with the current record day and timeline-derived times.
4. Reuse the existing request-form scroll/focus behavior.

## Design

### 1. Bridge from observation to correction

The previous slice exposed the day's raw punch timeline, but operators still had to:

- remember the day
- scroll down
- re-enter timestamps

This slice closes that gap with a `Use in request form` action in the detail row.

### 2. Safe default request shape

The bridge always preselects `time_correction`.

That is the safest request type because it accepts:

- both timestamps
- only `requestedInAt`
- only `requestedOutAt`

So the bridge does not need to guess a stricter missed-check-in or missed-check-out intent.

### 3. Timeline-derived draft values

The prefill logic resolves:

- earliest `check_in` as `requestedInAt`
- latest `check_out` as `requestedOutAt`
- existing record `first_in_at` / `last_out_at` as fallback

This keeps the bridge useful even when the raw event list is sparse.

### 4. No new state model

No store, no modal, no extra route.

The slice only extends the existing local timeline state and the existing request form.

## Non-goals

- No backend changes
- No automatic request submission
- No request-type inference beyond the safe `time_correction` default
- No new anomaly or approval workflow behavior
