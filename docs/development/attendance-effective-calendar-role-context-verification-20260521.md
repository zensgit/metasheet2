# Attendance Effective Calendar Role Context Verification

Date: 2026-05-21
Branch: `codex/attendance-effective-calendar-role-context-20260521`
Base: `origin/main@5565a5cd3`

## Verification Matrix

| Layer | Command | Result |
| --- | --- | --- |
| Plugin syntax | `node --check plugins/plugin-attendance/index.cjs` | PASS |
| Backend role-context unit | `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-effective-calendar-role-context.test.ts --reporter=dot` | PASS, 2 tests |
| Backend catalog/formula regression | `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-report-field-catalog.test.ts tests/unit/attendance-report-field-formula-engine.test.ts tests/unit/attendance-effective-calendar-role-context.test.ts --reporter=dot` | PASS, 58 tests |
| Backend attendance calendar integration smoke | `pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts -t "effective-calendar role/roleTags|resolveWorkContext applies calendarPolicy" --reporter=dot` | PASS, 2 selected tests loaded/passed, 72 skipped by existing integration gating |
| Frontend focused specs | `NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/useAttendanceHolidayRuleSection.spec.ts tests/useAttendanceAdminConfig.spec.ts tests/AttendanceCalendarPolicyPreviewPanel.spec.ts --watch=false` | PASS, 12 tests |
| Frontend admin regression | `NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/useAttendanceHolidayRuleSection.spec.ts tests/useAttendanceAdminConfig.spec.ts tests/AttendanceCalendarPolicyPreviewPanel.spec.ts tests/attendance-admin-regressions.spec.ts --watch=false` | PASS, 23 tests |
| Frontend type-check | `pnpm --filter @metasheet/web type-check` | PASS |
| Backend build | `pnpm --filter @metasheet/core-backend build` | PASS |
| Whitespace | `git diff --check` | PASS |

## Acceptance Criteria

- `filters.roles` matches a user whose resolver context contains the target
  value in either `users.role`, `user_roles.role_id`, or `roles.name`.
- `filters.roleTags` matches the same resolver alias corpus in v1, because no
  dedicated role-tag catalog exists yet.
- Single-user and batch prefetch paths produce the same role alias arrays.
- A role-scoped effective-calendar override produces a `calendar_policy` layer
  and `effective.source = "role"`.
- Punch-time `resolveWorkContext` writes `attendance_records.is_workday` using
  the role-scoped override.
- Admin UI no longer disables the role source option.
- Settings save payload keeps `filters.roles` and `filters.roleTags` for
  role-scoped calendar overrides.

## Boundary Checks

- No migration files added or changed.
- No `attendance_*` fact-source migration.
- No direct `meta_*` SQL write.
- No new frontend-only validator that could drift from the backend resolver.
- Existing org/group/user calendar override paths remain untouched except for
  shared role-aware scope matching.

## Notes

The integration smoke command followed the existing integration-file gating:
the selected tests loaded and passed, while unrelated DB-heavy cases were
skipped. The new unit tests cover the role-context loader logic without
requiring a database.
