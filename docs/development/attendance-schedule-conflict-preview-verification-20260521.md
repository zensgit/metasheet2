# Attendance Schedule Conflict Preview Verification

Date: 2026-05-21
Branch: `codex/attendance-schedule-conflict-preview-20260521`
Base: `origin/main@9af961d70`

## Verification Matrix

| Layer | Command | Result |
| --- | --- | --- |
| Frontend focused specs | `NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/attendanceScheduleConflictDiagnostics.spec.ts tests/AttendanceSchedulingAdminSection.spec.ts --watch=false` | PASS, 9 tests |
| Frontend type-check | `pnpm --filter @metasheet/web type-check` | PASS |
| Frontend scheduling regression | `NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/attendanceScheduleConflictDiagnostics.spec.ts tests/AttendanceSchedulingAdminSection.spec.ts tests/useAttendanceAdminScheduling.spec.ts tests/attendance-admin-regressions.spec.ts --watch=false` | PASS, 43 tests |
| Frontend build | `pnpm --filter @metasheet/web build` | PASS |
| Whitespace | `git diff --check` | PASS |

## Acceptance Criteria

- Overlapping active fixed shift assignments for the same user emit a warning.
- Overlapping active rotation assignments for the same user emit a warning.
- Rotation assignment overlap with a fixed shift assignment for the same user
  emits a warning that rotation wins at runtime.
- Inactive rows do not emit warnings.
- Incomplete drafts do not emit warnings until user/reference/start date exist.
- The extracted scheduling component displays diagnostics.
- The production `AttendanceView.vue` displays diagnostics in scheduling admin
  sections.

## Boundary Checks

- No backend file changed.
- No `plugins/plugin-attendance/index.cjs` change.
- No migration file added or changed.
- No direct `meta_*` SQL write.
- No staging/prod write operation.

## Notes

This is an advisory UI slice. It does not block save and does not alter runtime
selection. Existing backend behavior remains the source of truth.

The frontend build still emits the existing Vite warning about large chunks and
the mixed static/dynamic import of `WorkflowDesigner.vue`; the command exits 0.
