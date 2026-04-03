# Attendance Shift Delete Guard Design

## Context

Run 28 follow-up testing showed that deleting a shift could silently remove or strand live scheduling references.

Current runtime usage comes from two active paths:

- direct shift assignments in `attendance_shift_assignments`
- active rotation assignments whose active rule `shift_sequence` still contains the shift id

Historical or inactive records should not block cleanup.

## Decision

Gate `DELETE /api/attendance/shifts/{id}` with a pre-delete usage query.

Return `409 Conflict` when the shift is still referenced by:

- an active direct assignment with no past end date
- an active rotation assignment whose active rule still contains the shift id

If neither usage exists, keep the existing delete behavior.

## Scope

Changed files:

- `plugins/plugin-attendance/index.cjs`
- `packages/core-backend/tests/integration/attendance-plugin.test.ts`
- `packages/openapi/src/paths/attendance.yml`

No behavior change for malformed IDs (`400`) or missing shifts (`404`).
