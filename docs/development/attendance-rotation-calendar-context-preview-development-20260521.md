# Attendance Rotation Calendar Context Preview Development 2026-05-21

## Summary

This slice extends the rotation assignment impact preview with effective-calendar context. The assignment preview still projects the selected rotation rule over the draft date window, and now each preview row can show a compact calendar chip for notable user/date context such as a holiday, calendar policy override, or approved overlay.

The key wording is intentional: this is calendar context for the selected user/date, not the final computed result of an unsaved draft rotation assignment. Runtime scheduling truth remains in the backend.

## Scope

- Reuse the existing `/api/attendance/effective-calendar` frontend client.
- Reuse existing calendar display helpers:
  - `effectiveCalendarItemToChip`
  - `isCalendarEffectiveItemNoteworthy`
  - `calendarChipSourceClassName`
  - `hasCalendarChipOverrideMarker`
  - `buildCalendarChipTooltip`
  - `fallbackChipName`
- Enrich rotation assignment preview rows by date when effective-calendar chips are available.
- Keep `AttendanceSchedulingAdminSection.vue` parity through an optional `rotationAssignmentCalendarChips` prop.
- Let production `AttendanceView.vue` fetch effective-calendar chips for the draft `userId` and visible preview date range.

## Boundaries

- No backend route changes.
- No database migration.
- No direct `attendance_*` fact-source changes.
- No direct `meta_*` reads or writes.
- No save-blocking frontend validator.
- No attempt to make the backend evaluate unsaved rotation assignment drafts.

## Behavior

In production `AttendanceView.vue`, when the rotation assignment draft has a selected user, selected rotation rule, valid start date, and visible preview rows:

1. The UI computes the visible preview date range.
2. It fetches effective-calendar data for `{ userId, from, to }`.
3. It filters to noteworthy items only, matching the personal calendar behavior.
4. It converts effective-calendar items into chips.
5. It indexes chips by date and attaches matching chip context to the existing preview rows.

Fetch failures clear only the context chips. The assignment preview remains visible, and save behavior is unchanged.

## Files Changed

- `apps/web/src/views/attendance/attendanceRotationSequencePreview.ts`
  - Added optional calendar context on assignment preview rows.
  - Added `buildAttendanceRotationAssignmentCalendarMap()`.
- `apps/web/src/views/attendance/AttendanceSchedulingAdminSection.vue`
  - Added optional effective-calendar chip rendering for extracted scheduling UI parity.
- `apps/web/src/views/AttendanceView.vue`
  - Added draft-range effective-calendar fetch and chip rendering in the production admin surface.
- `apps/web/tests/attendanceRotationSequencePreview.spec.ts`
  - Added date-based calendar context attachment coverage.
- `apps/web/tests/AttendanceSchedulingAdminSection.spec.ts`
  - Added calendar chip rendering assertions on the assignment preview.

## Design Notes

The preview is deliberately scoped to the already visible rows, currently capped at 14 days. Long assignments still show a bounded sample, and the calendar fetch uses the same visible sample range. This keeps the surface responsive and avoids introducing a background scheduling simulator.
