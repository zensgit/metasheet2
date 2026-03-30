# Attendance Record Timeline UI Design

## Goal

Expose the raw punch-event sequence directly inside the existing `Records` card so operators can inspect a day's actual check-in/check-out timeline without leaving the overview page.

This is intentionally a small stacked slice on top of the pending punch-events backend PR:

- no new route
- no new store
- no new full-page panel

## Scope

1. Add a trailing action column to the records table.
2. Let each record row expand into an inline detail row.
3. Lazy-load `GET /api/attendance/punch/events` for the selected work date.
4. Cache successful timeline responses per row for the current table load.
5. Treat `404/405` as endpoint-unavailable inline fallback instead of a page-level error banner.

## Design

### 1. Inline expand row inside the existing records table

The records card already owns the right context:

- work date
- first in / last out
- day status

So the smallest useful UI is a second `<tr>` under the selected record, following the same inline-meta pattern already used elsewhere in `AttendanceView.vue`.

### 2. Lazy fetch with row-local state

The view keeps only local state:

- `expandedRecordId`
- `recordTimelineLoadingId`
- `recordTimelineById`
- `recordTimelineErrorById`
- `recordTimelineSupported`

That keeps the feature isolated to `AttendanceView.vue` and avoids pushing a one-card interaction into global state.

### 3. Tolerant client-side normalization

The backend contract already emits snake/camel duplicates. The UI normalizes each event into one tolerant local type so the template does not care whether it receives:

- `occurredAt` or `occurred_at`
- `eventType` or `event_type`
- `workDate` or `work_date`
- `userId` or `user_id`

### 4. Endpoint-unavailable fallback is silent and local

If the server answers `404` or `405`, the UI marks the timeline endpoint as unsupported for the page and renders an inline message:

- it does not flip the page-level status banner into an error state
- it does not keep re-requesting the same unsupported endpoint on reopen

This keeps the new UI safe to stack before the backend PR lands everywhere.

## Non-goals

- No admin-console changes
- No new punch-event management UI
- No pagination inside the timeline row
- No mobile-specific redesign beyond using the existing responsive table behavior
