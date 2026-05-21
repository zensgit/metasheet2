# Attendance Calendar Policy Preview UI

Date: 2026-05-21
Branch: `codex/attendance-calendar-policy-preview-ui-20260521`
Base: `origin/main@d611bb6bb`

## Summary

This slice adds a read-only preview panel beside the effective-calendar
override editor. Operators can choose a date range and an org / attendance-group
/ user scope, then run the already-shipped
`GET /api/attendance/effective-calendar` resolver directly from the settings
surface.

The panel is intentionally frontend-only. It does not add a backend route,
write settings, migrate `attendance_*`, or introduce any direct `meta_*` write.
It previews saved policy behavior; unsaved editor changes still need to be
saved through the existing settings path before they affect the resolver.

## Key Changes

| File | Purpose |
| --- | --- |
| `apps/web/src/views/attendance/AttendanceCalendarPolicyPreviewPanel.vue` | New shared preview panel, local state, validation, resolver call, result table |
| `apps/web/src/views/attendance/AttendanceHolidayRuleSection.vue` | Mounts the shared preview panel in the extracted holiday-rule section |
| `apps/web/src/views/AttendanceView.vue` | Mounts the same preview panel in the currently routed monolithic admin view |
| `apps/web/tests/AttendanceCalendarPolicyPreviewPanel.spec.ts` | Focused frontend coverage for org preview, target validation, and backend error rendering |

## UI Contract

The preview panel supports:

- Date range: `from` and `to`, with client-side guard that `from <= to`.
- Scope mode: organization, attendance group, or user.
- Target requirement: group mode requires a group ID/code; user mode requires a
  user ID; organization mode sends `orgOnly=true`.
- Result display: date, base day type/source, effective day type/source, label
  or policy id, layer summary, and overlay summary.

The panel always sends `suppressUnauthorizedRedirect: true`, matching the shared
effective-calendar client contract used by calendar widgets. Authorization and
resolver semantics remain backend-owned.

## Boundaries

- No backend code changed.
- No new client-side resolver or validator was introduced.
- No `attendance_*` migration or fact-source migration.
- No direct `meta_*` reads or writes.
- No save-path change. The only persistence path remains
  `PUT /api/attendance/settings`.
- The extracted section and the production `AttendanceView.vue` mount the same
  component to avoid UI drift.

## Deferred

- Previewing unsaved draft overrides. That would require a backend simulation
  endpoint or a clearly scoped draft-payload resolver and is intentionally not
  part of this slice.
- Role / role-tag target preview. The backend resolver still treats role-based
  calendar policy as configuration-compatible but inert until role context is
  loaded.
- Live staging evidence. This frontend slice is covered by unit tests; staging
  confirmation can reuse the existing saved-policy flow after deployment.
