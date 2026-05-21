# Attendance Calendar Policy Admin UI

Date: 2026-05-20
Branch: `codex/attendance-calendar-policy-admin-ui-20260520`
Base: `origin/main@37013f269`

## Summary

This slice adds an admin editor for `settings.calendarPolicy.overrides[]`,
the policy layer introduced by the effective-calendar resolver and then
routed into the attendance calculation chain. Before this slice, operators
could see effective calendar results but still had to edit the policy array
through raw settings JSON. The new UI exposes the same persisted shape through
the attendance holiday/settings surface.

No backend route, migration, `attendance_*` fact table, or `meta_*` write path
changed. The save path remains the existing `PUT /api/attendance/settings`
route, which already normalizes and validates `calendarPolicy.overrides[]`.

## Scope

Delivered:

- Shared frontend helper:
  `apps/web/src/views/attendance/attendanceCalendarPolicyOverrides.ts`
  handles wire-to-form and form-to-wire mapping.
- `useAttendanceAdminConfig` now loads/saves `calendarPolicy.overrides[]`
  alongside existing holiday settings.
- `AttendanceHolidayRuleSection.vue` gets an accordion editor for effective
  calendar overrides.
- `AttendanceView.vue` gets the same editor in the currently mounted
  monolithic admin settings section, so the production route has the entry
  point immediately.
- Focused tests cover load/save serialization and component rendering.

Not delivered:

- A new backend preview endpoint. Operators can verify behavior through the
  existing effective-calendar surfaces after save.
- Role / roleTag matching. The option is shown as reserved/disabled because
  the backend resolver still does not load role context.
- Bulk import/export of policy overrides.

## UI Contract

The editor supports:

- Constraints: single `date`, `from`/`to`, holiday `name` with match mode,
  `dayIndexStart`, `dayIndexEnd`, `dayIndexList`.
- Scope source: organization, attendance group, user. Role is displayed as
  reserved and disabled for new rules.
- Filters: attendance groups, user IDs/names, excluded user IDs/names.
- Effective result: working day vs rest day, plus optional display label.

Rows are serialized only when they have at least one date/name/day-index
constraint and satisfy the backend source/filter requirement:

| Source | Required filter |
| --- | --- |
| `org` | none |
| `group` | `attendanceGroups` |
| `user` | `userIds` or `userNames` |
| `role` | `roles` or `roleTags` (reserved/inert in v1) |

This mirrors the backend normalizer and avoids silently saving rows that the
backend would drop.

## Boundary Notes

- `holidayPolicy.overrides[]` and `calendarPolicy.overrides[]` stay separate.
  The former affects holiday pay/overtime interpretation; the latter answers
  whether a date is effectively a working day for org/group/user scope.
- The editor explicitly warns that rest-to-work policy changes feed the
  calculation chain and can produce auto-absence rows after the auto-absence
  job runs.
- Role and roleTag policy rows remain configuration-compatible but resolver
  inert until a future role-context loader exists.

## Files Changed

| File | Purpose |
| --- | --- |
| `apps/web/src/views/attendance/attendanceCalendarPolicyOverrides.ts` | Shared wire/form mapper and source/filter guard |
| `apps/web/src/views/attendance/useAttendanceAdminConfig.ts` | Load/save calendar policy through existing settings API |
| `apps/web/src/views/attendance/AttendanceHolidayRuleSection.vue` | Extracted-section UI editor |
| `apps/web/src/views/AttendanceView.vue` | Mounted admin settings UI editor |
| `apps/web/tests/useAttendanceAdminConfig.spec.ts` | Load/save serialization coverage |
| `apps/web/tests/useAttendanceHolidayRuleSection.spec.ts` | Render/add-control coverage |
