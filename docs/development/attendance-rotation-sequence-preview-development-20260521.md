# Attendance Rotation Sequence Preview Development

Date: 2026-05-21
Branch: `codex/attendance-rotation-sequence-preview-20260521`
Base: `origin/main@663e7646e`

## Summary

This slice adds a small admin-side preview for rotation rule shift sequences.
Admins can see the resolved day-by-day cycle before saving a rotation rule:

- `Day 1 / Day 2 / ...` rows show the loaded shift name, id, schedule, and
  overnight marker.
- Missing shift references are called out when the shift catalog is loaded.
- The quick-append buttons in the extracted scheduling section and production
  `AttendanceView.vue` both build the same comma-separated sequence.

This is a frontend advisory slice only. Backend rotation-rule validation remains
the source of truth for whether a sequence can be saved.

## Scope

Delivered:

- A shared pure helper in
  `apps/web/src/views/attendance/attendanceRotationSequencePreview.ts`.
- Rotation sequence preview rendering in
  `apps/web/src/views/attendance/AttendanceSchedulingAdminSection.vue`.
- Rotation sequence quick append and preview rendering in the production
  `apps/web/src/views/AttendanceView.vue` scheduling surface.
- Focused helper and component tests.
- Development and verification notes.

Not delivered:

- No backend rotation-rule validator change.
- No migration or schema change.
- No auto-repair of legacy name-based `shiftSequence` entries.
- No save blocking beyond the existing backend validation path.

## Design Notes

`attendance_rotation_rules.shift_sequence` is persisted as an ordered array of
string references. Current backend create/update validation requires shift IDs,
while older docs and delete-guard history acknowledge legacy deployments may
have name-like entries. The preview therefore stays advisory:

- it resolves references against the currently loaded shift catalog by `id`;
- it reports missing references only when at least one shift is loaded;
- it still displays unresolved references so admins can inspect legacy values;
- it does not decide whether the backend will accept the save.

The parser accepts comma or newline separators, matching the existing
`parseShiftSequenceInput()` behavior in the production monolith.

## Changed Files

- `apps/web/src/views/attendance/attendanceRotationSequencePreview.ts`
  - New parser and preview builder.
- `apps/web/src/views/attendance/AttendanceSchedulingAdminSection.vue`
  - Renders cycle preview and missing-reference warning.
- `apps/web/src/views/AttendanceView.vue`
  - Adds quick append parity and renders the same preview in the active admin
    page.
- `apps/web/tests/attendanceRotationSequencePreview.spec.ts`
  - Pure helper coverage.
- `apps/web/tests/AttendanceSchedulingAdminSection.spec.ts`
  - Component rendering coverage.

## Boundaries

- No `attendance_*` migration.
- No direct `meta_*` write.
- No plugin/backend route change.
- No new client-side save validator.
- No staging/prod write operation.
