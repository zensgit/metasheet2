# Attendance Calendar Policy Conflict Hints Development

Date: 2026-05-21
Branch: `codex/attendance-calendar-conflict-hints-20260521`
Base: `origin/main@515fd8f9a`

## Summary

This slice adds admin-side diagnostics for effective-calendar override rows.
It catches the two highest-risk configuration mistakes before save:

- scoped rows that would be silently dropped by
  `calendarPolicyOverridesFromForm()` because the required source filter is
  empty;
- overlapping same-source/same-target rows where the later row changes the
  effective result and therefore wins on overlapping days.

It also flags inverted date ranges. The effective-calendar backend resolver,
attendance calculation chain, facts, settings storage shape, and preview API are
unchanged.

## Scope

Delivered:

- A pure helper,
  `buildCalendarPolicyOverrideDiagnostics(forms)`, in
  `attendanceCalendarPolicyOverrides.ts`.
- Warning UI in both the production `AttendanceView.vue` section and the
  extracted `AttendanceHolidayRuleSection.vue` component.
- Focused unit coverage for the helper and component rendering.
- Development and verification notes for this slice.

Not delivered:

- No backend validator or new settings route.
- No resolver priority change. Existing source priority and same-source
  later-row tie behavior remain authoritative.
- No auto-fix, reorder, dedupe, or delete behavior.

## Diagnostic Semantics

### Missing Scope

`group`, `role`, and `user` rows already require a matching source filter before
they are included in the save payload:

- `group`: `attendanceGroups`
- `role`: `roles` or `roleTags`
- `user`: `userIds` or `userNames`

The new UI warning mirrors that existing save normalization. It does not block
save, but tells the admin that the row will not be persisted.

### Invalid Date Range

Rows with both `from` and `to` set are checked lexically as `YYYY-MM-DD`. If
`from > to`, the row gets a warning. Single-date rows and open-ended partial
ranges are not treated as overlap candidates.

### Same-Source Shadowing

The backend selector uses source priority and later-array-order wins for
same-priority ties. The frontend helper therefore only warns when all of these
are true:

- both rows have concrete overlapping dates;
- both rows use the same `effective.source`;
- normalized target filters match exactly, including holiday name/match,
  day-index filters, attendance groups, roles, role tags, users, and excludes;
- effective output differs (`isWorkingDay` or label).

Different-source overlaps are expected priority behavior and are not flagged in
this slice.

## Changed Files

- `apps/web/src/views/attendance/attendanceCalendarPolicyOverrides.ts`
  - Added diagnostic types and pure helper functions.
- `apps/web/src/views/attendance/AttendanceHolidayRuleSection.vue`
  - Displays diagnostics in the extracted holiday/effective-calendar section.
- `apps/web/src/views/AttendanceView.vue`
  - Displays the same diagnostics in the current production admin UI.
- `apps/web/tests/attendanceCalendarPolicyOverrides.spec.ts`
  - New helper coverage.
- `apps/web/tests/useAttendanceHolidayRuleSection.spec.ts`
  - Component rendering coverage for diagnostics.

## Boundaries

- No `attendance_*` migration.
- No direct `meta_*` writes.
- No plugin/backend route changes.
- No new client-side resolver. The helper only explains existing save and
  resolver semantics.
- No staging/prod write operation.
