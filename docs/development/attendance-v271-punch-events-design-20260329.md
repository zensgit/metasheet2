# Attendance v2.7.1 Punch Events Design

## Goal

Expose a read-only punch timeline endpoint that returns raw check-in/check-out events for a date range.

This addresses the remaining test gap where users can only see derived `first_in_at / last_out_at` values but cannot inspect the underlying punch sequence for a day.

## Scope

Smallest safe slice:

1. Add `GET /api/attendance/punch/events?from=&to=`.
2. Keep the route read-only and backend-only.
3. Reuse existing attendance read permissions and cross-user guardrails.
4. Exclude non-punch synthetic events such as `adjustment`.

## Route Contract

- Default target user: current authenticated user.
- Organization scope: current authenticated org only.
- Optional `userId` query parameter: allowed only through existing `canAccessOtherUsers()` logic.
- Date filters:
  - `from`
  - `to`
- Pagination:
  - `page`
  - `pageSize`
  - `pageSize` is clamped by the shared pagination helper to a maximum of `200`

Response shape follows the existing `records/anomalies` list envelope:

- `ok`
- `data.items`
- `data.total`
- `data.page`
- `data.pageSize`
- `data.from`
- `data.to`

Each item exposes both camelCase and snake_case aliases for stability:

- `userId` / `user_id`
- `orgId` / `org_id`
- `workDate` / `work_date`
- `occurredAt` / `occurred_at`
- `eventType` / `event_type`

## Why Backend-only

The current frontend already has a natural future consumer in the `Records` section, but adding UI now would widen scope and initial overview load cost.

The better follow-up is a lazy row expander or detail pane under records, fetched on demand from this endpoint.

## Non-goals

- No new tab or route in the UI.
- No new schema or migration.
- No inclusion of request-generated `adjustment` events in the punch timeline.
