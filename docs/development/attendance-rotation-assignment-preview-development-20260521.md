# Attendance Rotation Assignment Preview Development 2026-05-21

## Summary

This slice adds a frontend-only advisory preview for rotation assignments. When an admin selects a rotation rule and date window, the UI now projects the first scheduled days for that user assignment from the rule sequence and the loaded shift catalog.

The change builds on the earlier conflict diagnostics and rotation sequence preview work:

- Conflict diagnostics still explain overlap risk between fixed shift assignments and rotation assignments.
- Rotation rule sequence preview still explains the rule cycle itself.
- This slice bridges those two surfaces by showing what the selected rotation assignment will do on concrete dates before the admin saves it.

## Scope

- Add `buildAttendanceRotationAssignmentPreview()` to the existing rotation sequence preview helper.
- Render assignment impact preview in `AttendanceSchedulingAdminSection.vue`.
- Keep production `AttendanceView.vue` in parity with the extracted scheduling section.
- Add focused unit and component coverage.
- Add this development note and a verification note.

## Boundaries

- No backend routes.
- No database migration.
- No `attendance_*` fact-source change.
- No direct `meta_*` reads or writes.
- No new save-blocking validator.
- Preview remains advisory; backend save behavior is unchanged.

## Behavior

The preview uses:

- `rotationAssignmentForm.rotationRuleId`
- `rotationAssignmentForm.startDate`
- `rotationAssignmentForm.endDate`
- loaded `rotationRules`
- loaded `shifts`

For closed ranges, it projects each date from `startDate` through `endDate`, capped at 14 visible rows. For open-ended ranges, it projects 14 days. The sequence repeats by modulo over `rotationRule.shiftSequence`.

Known shift IDs display shift name, ID, schedule, and overnight marker. Unknown shift IDs remain visible and are reported once in a warning. This mirrors the prior sequence preview behavior and avoids silently hiding legacy or not-yet-loaded references.

## Files Changed

- `apps/web/src/views/attendance/attendanceRotationSequencePreview.ts`
  - Added assignment preview types and `buildAttendanceRotationAssignmentPreview()`.
- `apps/web/src/views/attendance/AttendanceSchedulingAdminSection.vue`
  - Added the advisory assignment impact preview panel near rotation assignment conflict diagnostics.
- `apps/web/src/views/AttendanceView.vue`
  - Added the same production monolith preview to keep parity until the extracted section fully replaces it.
- `apps/web/tests/attendanceRotationSequencePreview.spec.ts`
  - Added date-window, open-ended cap, missing-ref, and truncation coverage.
- `apps/web/tests/AttendanceSchedulingAdminSection.spec.ts`
  - Added component coverage for rendered assignment impact preview rows.

## Notes

This is intentionally not a full calendar renderer and does not apply holidays, effective working-day overrides, or runtime attendance calculation. It is an operator-facing preview of the selected rotation rule sequence over dates. Runtime truth remains in backend scheduling evaluation.
