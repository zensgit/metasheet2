# Attendance Effective Calendar Role Context Development

Date: 2026-05-21
Branch: `codex/attendance-effective-calendar-role-context-20260521`
Base: `origin/main@5565a5cd3`

## Summary

This slice removes the last inert scope in `calendarPolicy.overrides[]`: role
and role-tag filters now participate in the effective-calendar resolver and the
attendance calculation chain. The facts remain in `attendance_*` SQL tables;
settings still live in the existing attendance settings payload; no migration
or direct `meta_*` write is introduced.

## Scope

Delivered:

- Single-user resolver context now loads role aliases from:
  - `users.role`
  - assigned `user_roles.role_id`
  - assigned `roles.name`
- Batch prefetch context (`loadAttendanceScopeContextMapForUsers`) loads the
  same aliases so payroll/import/auto-absence/range calculations observe the
  same calendar policy as `/api/attendance/effective-calendar`.
- `matchScopeFilters` now checks `filters.roles` against both `ctx.role` and
  `ctx.roles[]`.
- `filters.roleTags` now works in resolver mode via the same alias set.
- Admin UI no longer marks role-scoped effective-calendar overrides as
  reserved; both production `AttendanceView.vue` and extracted
  `AttendanceHolidayRuleSection.vue` show the active resolver semantics.

Not delivered:

- A dedicated role-tag catalog/table. Current RBAC schema has no role-tag
  column, so v1 exposes role ids/names as tag-like aliases.
- Any new attendance fact table, migration, or persistence path.

## Design Decisions

### Role Alias Corpus

The RBAC schema provides `users.role`, `user_roles.role_id`, and `roles.name`.
There is no independent `role_tags` table. To keep behavior deterministic and
avoid silent inert fields, resolver-mode `roleTags` intentionally uses the same
normalized alias corpus as `roles`.

This mirrors the existing import/profile path, where DingTalk `职位` can populate
both `role` and `roleTags`.

### Resolver Parity

The implementation updates both:

- `loadAttendanceScopeContextForUser` for single-user API/punch paths.
- `loadAttendanceScopeContextMapForUsers` for prefetch paths.

This keeps Step 5 cutover parity intact: read-only effective-calendar, punch
writeback, payroll/import, auto-absence, and summary consumers all see the same
role-scoped calendar policy.

### Degraded Compatibility

Role context loading follows the existing attendance scope loader posture:
schema absence degrades to empty role arrays instead of failing calendar
resolution. User name loading retains a fallback query when `users.role` is not
available on older environments.

## Changed Files

- `plugins/plugin-attendance/index.cjs`
  - Added role alias accumulator helpers.
  - Extended single and batch scope context loaders.
  - Extended `matchScopeFilters` to evaluate `ctx.roles[]`.
  - Exported scope helpers in the unit-test surface.
- `apps/web/src/views/attendance/AttendanceHolidayRuleSection.vue`
  - Enabled role scope option.
  - Replaced reserved warning with active resolver semantics.
- `apps/web/src/views/AttendanceView.vue`
  - Same production UI copy/option update.
- `packages/core-backend/tests/unit/attendance-effective-calendar-role-context.test.ts`
  - New unit coverage for single/batch role context and scope matching.
- `packages/core-backend/tests/integration/attendance-plugin.test.ts`
  - Replaced inert-role effective-calendar test with active role/roleTag
    matching.
  - Updated punch cutover test so role-scoped override flips `is_workday`.
- `apps/web/tests/useAttendanceHolidayRuleSection.spec.ts`
  - Role source option is enabled and role inputs remain visible.
- `apps/web/tests/useAttendanceAdminConfig.spec.ts`
  - Save payload preserves role/roleTag filters for role-scoped overrides.

## Boundaries

- No `attendance_*` migration.
- No direct `meta_*` writes.
- No new settings route or storage shape.
- No client-side calendar-policy validator.
- No change to org/group/user precedence or same-source tie order.
