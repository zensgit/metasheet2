# Attendance Shift Assignment Preview Development 2026-05-21

## Summary

This slice adds a frontend-only advisory preview for fixed shift assignments.
It mirrors the rotation assignment impact preview, but for the simpler
`assignmentForm.shiftId + startDate/endDate` path.

The preview shows the selected shift across the visible assignment date window
and can attach effective-calendar context for the selected user/date when the
backend resolver returns notable holiday, policy, or overlay chips.

The wording is intentional: this is an operator preview of the current draft
inputs and calendar context, not the final backend scheduling result of an
unsaved assignment. Runtime scheduling truth and save validation remain in the
backend.

## Scope

- Extend the existing rotation preview helper module with fixed shift
  assignment preview helpers.
- Render the preview in the extracted `AttendanceSchedulingAdminSection.vue`.
- Render the same preview in production `AttendanceView.vue`.
- Reuse the existing `/api/attendance/effective-calendar` frontend client.
- Reuse existing calendar chip helpers and noteworthy-item filtering.
- Keep the preview bounded to the same 14 visible rows as rotation assignment
  previews.

## Boundaries

- No backend route changes.
- No database migration.
- No direct `attendance_*` fact-source changes.
- No direct `meta_*` reads or writes.
- No save-blocking frontend validator.
- No attempt to simulate final backend resolution for an unsaved assignment.

## Behavior

The fixed shift assignment preview uses:

- `assignmentForm.userId`
- `assignmentForm.shiftId`
- `assignmentForm.startDate`
- `assignmentForm.endDate`
- the currently loaded shift catalog

For closed ranges, it projects each date from `startDate` through `endDate`,
capped at 14 visible rows. For open-ended ranges, it projects the first 14
days.

Known shift IDs display shift name, ID, schedule, and overnight marker.
Unknown shift IDs remain visible and are reported only when a shift catalog is
loaded. This avoids hiding legacy or not-yet-loaded references.

In production `AttendanceView.vue`, when the fixed assignment draft has a
selected user and visible preview rows:

1. The UI computes the visible preview date range from the base preview without
   calendar context.
2. It fetches effective-calendar data for `{ userId, from, to }`.
3. It filters to noteworthy items only.
4. It converts those effective-calendar items into chips.
5. It indexes chips by date and attaches matching chip context to preview rows.

Fetch failures only clear the context chips and reset the cache key. The shift
preview and save behavior remain unchanged.

## Files Changed

- `apps/web/src/views/attendance/attendanceRotationSequencePreview.ts`
  - Added `buildAttendanceShiftAssignmentPreview()`.
  - Added `buildAttendanceShiftAssignmentCalendarMap()`.
  - Added fixed shift assignment preview types.
- `apps/web/src/views/attendance/AttendanceSchedulingAdminSection.vue`
  - Added optional fixed assignment calendar chips prop.
  - Added fixed shift assignment impact preview rendering.
- `apps/web/src/views/AttendanceView.vue`
  - Added fixed assignment preview rendering in the production admin surface.
  - Added visible-range effective-calendar fetch for the fixed assignment
    draft.
- `apps/web/tests/attendanceRotationSequencePreview.spec.ts`
  - Added helper coverage for date projection, truncation, missing shift refs,
    and calendar context attachment.
- `apps/web/tests/AttendanceSchedulingAdminSection.spec.ts`
  - Added component coverage for rendered fixed assignment preview rows and
    effective-calendar chip metadata.

## Design Notes

The effective-calendar cache key intentionally excludes `shiftId`. The backend
endpoint resolves saved user/date context and does not evaluate the unsaved
draft shift assignment. Re-fetching on shift changes would suggest a stronger
truth than the API can provide.

The preview remains a small ergonomic safety surface: it helps admins see the
dates and selected shift they are about to save, while conflict diagnostics and
backend validation remain authoritative for overlap and persistence semantics.
