# Attendance Calendar Policy Conflict Hints Verification

Date: 2026-05-21
Branch: `codex/attendance-calendar-conflict-hints-20260521`
Base: `origin/main@515fd8f9a`

## Verification Matrix

| Layer | Command | Result |
| --- | --- | --- |
| Frontend focused specs | `NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/attendanceCalendarPolicyOverrides.spec.ts tests/useAttendanceHolidayRuleSection.spec.ts --watch=false` | PASS, 10 tests |
| Frontend type-check | `pnpm --filter @metasheet/web type-check` | PASS |
| Frontend admin regression | `NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/attendanceCalendarPolicyOverrides.spec.ts tests/useAttendanceHolidayRuleSection.spec.ts tests/useAttendanceAdminConfig.spec.ts tests/AttendanceCalendarPolicyPreviewPanel.spec.ts tests/attendance-admin-regressions.spec.ts --watch=false` | PASS, 28 tests |
| Frontend build | `pnpm --filter @metasheet/web build` | PASS |
| Whitespace | `git diff --check` | PASS |

## Acceptance Criteria

- A role/group/user-scoped effective-calendar row with a date or range but no
  required source filter surfaces a visible warning before save.
- The warning mirrors current save behavior: incomplete scoped rows are still
  omitted by `calendarPolicyOverridesFromForm()`.
- Inverted `from` / `to` ranges are reported.
- Overlapping same-source, same-target rows with different effective outputs
  report that the later row wins on overlapping days.
- Equivalent same-source rows and non-overlapping rows do not emit a false
  warning.
- Both the extracted `AttendanceHolidayRuleSection.vue` and production
  `AttendanceView.vue` render the same diagnostic block.

## Boundary Checks

- No backend file changed.
- No `plugins/plugin-attendance/index.cjs` change.
- No migration file added or changed.
- No direct `meta_*` SQL write.
- No staging/prod write operation.

## Notes

This is an advisory UI slice. It intentionally does not block save or
re-implement the backend resolver. The source of truth remains the existing
save normalization and effective-calendar backend selector.

The frontend build emitted the existing Vite chunk-size/dynamic-import warnings;
the build completed successfully.
