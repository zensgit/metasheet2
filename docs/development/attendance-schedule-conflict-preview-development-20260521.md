# Attendance Schedule Conflict Preview Development

Date: 2026-05-21
Branch: `codex/attendance-schedule-conflict-preview-20260521`
Base: `origin/main@9af961d70`

## Summary

This slice adds admin-side conflict hints for the attendance scheduling surfaces.
It explains existing runtime behavior before admins have to discover it through
calculation results:

- overlapping fixed shift assignments for the same user;
- overlapping rotation assignments for the same user;
- fixed shift assignments overlapped by rotation assignments, where runtime
  resolution already gives rotation priority.

The attendance fact source remains `attendance_*`. This is a frontend advisory
slice only; no resolver, route, migration, or persistence behavior changes.

## Scope

Delivered:

- A shared pure helper,
  `buildAttendanceScheduleConflictDiagnostics()`, in
  `attendanceScheduleConflictDiagnostics.ts`.
- Diagnostic rendering in the production `AttendanceView.vue` scheduling
  sections.
- Diagnostic rendering in the extracted
  `AttendanceSchedulingAdminSection.vue` component to keep the refactor surface
  in parity.
- Focused helper and component tests.
- Development and verification notes.

Not delivered:

- No backend conflict-blocking validator.
- No auto-fix, dedupe, delete, reorder, or split-assignment action.
- No effective-calendar preview integration. Calendar policy diagnostics remain
  a separate slice.

## Runtime Semantics Mirrored

The helper mirrors the current backend resolver posture:

- `resolveWorkContext()` chooses `rotationInfo?.shift` before
  `assignmentInfo?.shift`, so rotation assignments override overlapping fixed
  shift assignments for the same user.
- `loadShiftAssignment()` and `loadRotationAssignment()` both order by
  `start_date DESC, created_at DESC` and select one row. When same-kind rows
  overlap, admins should know the backend will pick the latest matching row
  rather than combine both.
- Inactive assignments are ignored.
- Rows or drafts with missing user/reference/start date are ignored until they
  are specific enough to reason about.
- Invalid draft date ranges are ignored by this advisory helper because existing
  save validation already blocks them.

## UI Placement

The production monolith still owns the active admin page, while
`AttendanceSchedulingAdminSection.vue` carries the extracted/refactor surface.
The warning block is therefore rendered in both:

- `AttendanceView.vue`
  - Rotation assignment section.
  - Shift assignment section.
- `AttendanceSchedulingAdminSection.vue`
  - Scheduling conflict block before assignment editors/tables.

## Changed Files

- `apps/web/src/views/attendance/attendanceScheduleConflictDiagnostics.ts`
  - New helper, diagnostic types, and formatter.
- `apps/web/src/views/attendance/AttendanceSchedulingAdminSection.vue`
  - Uses the helper and displays schedule conflict warnings.
- `apps/web/src/views/AttendanceView.vue`
  - Displays the same warnings in the production scheduling sections.
- `apps/web/tests/attendanceScheduleConflictDiagnostics.spec.ts`
  - Helper unit coverage.
- `apps/web/tests/AttendanceSchedulingAdminSection.spec.ts`
  - Component rendering coverage.

## Boundaries

- No `attendance_*` migration.
- No direct `meta_*` writes.
- No plugin/backend route changes.
- No new client-side resolver for attendance calculation; the helper only
  explains existing backend precedence.
- No staging/prod write operation.
