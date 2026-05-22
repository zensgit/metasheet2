# Attendance Advanced Scheduling Scope Foundation Development

Date: 2026-05-22
Branch: `codex/attendance-schedule-groups-scope-20260522`

## Summary

This slice turns the advanced-scheduling design lock into the first backend
foundation: DingTalk-like `排班班组` and `排班人` now have explicit SQL models,
admin-only API surfaces, and pure helper contracts for date-aware membership
windows and scoped scheduler actions.

It intentionally does not build the dense schedule grid, Excel import/export,
temporary shift drawing, dispatch optimizer, frontend UI, or multitable snapshot
sync. Those remain follow-up slices after this ownership model is stable.

## Changed Files

| File | Change |
| --- | --- |
| `packages/core-backend/src/db/migrations/zzzz20260522100000_create_attendance_schedule_groups.ts` | Adds `attendance_schedule_groups`, `attendance_schedule_group_members`, and `attendance_scheduler_scopes` with idempotent indexes and date-window guardrails. |
| `plugins/plugin-attendance/index.cjs` | Adds mappers/normalizers/scope helpers and admin-only CRUD/list routes for schedule groups, date-aware members, and scheduler scopes. |
| `packages/core-backend/tests/unit/attendance-advanced-scheduling-scope.test.ts` | Locks the migration boundary, route guard wiring, schedule-group normalization, membership window semantics, and scheduler-scope matching. |
| `docs/development/attendance-advanced-scheduling-scope-foundation-development-20260522.md` | This development note. |
| `docs/development/attendance-advanced-scheduling-scope-foundation-verification-20260522.md` | Verification evidence for this slice. |

## Data Model

### `attendance_schedule_groups`

Operational scheduling groups are separate from `attendance_groups`.

Key fields:

- `name`, `code`, `description`
- optional `attendance_group_id` reference
- optional `parent_id` for small-organization nesting
- `department_ref` as a string reference
- `source`: `manual | import | integration`
- `is_active` for soft-delete semantics
- `created_by`, `updated_by`, timestamps

Important contract:

- The table references `attendance_groups` when useful, but does not mutate or
  replace it.
- Active `(org_id, name)` and non-null `(org_id, code)` are unique.
- Delete route soft-deactivates instead of cascading schedule history away.

### `attendance_schedule_group_members`

Membership is date-aware.

Key fields:

- `schedule_group_id`
- `user_id`
- `effective_from`, `effective_to`
- `role`: `member | lead | backup`
- `source`: `manual | import | integration`

Important contract:

- A check constraint rejects `effective_to < effective_from`.
- API write path rejects overlapping windows for the same org/group/user.
- The member-create route serializes writes with a transaction-scoped advisory
  lock keyed by `orgId:scheduleGroupId:userId` before running the overlap query,
  so concurrent requests for the same member cannot both pass the pre-insert
  check. Exact duplicate-window unique violations are also mapped to
  `409 MEMBERSHIP_OVERLAP`.
- This does not change `attendance_group_members`.

### `attendance_scheduler_scopes`

Scheduler delegation is explicit and action-scoped.

Key fields:

- `subject_type`: `user | role | role_tag`
- `subject_ref`
- `actions`: `view | edit | import | export | clear | approve | dispatch`
- `scope` JSON object with `scheduleGroupIds`, `attendanceGroupIds`, `userIds`,
  `departments`, `roles`, `roleTags`
- `is_active`

Important contract:

- Empty scope is invalid. Only `attendance:admin` remains global.
- `view` does not imply `edit`; every action is explicit.
- CRUD routes are admin-only in this foundation slice. Scoped non-admin
  enforcement is reserved for future grid/write endpoints.

## API Surface

All routes are guarded by `attendance:admin`.

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/api/attendance/schedule-groups` | List active schedule groups, `includeInactive=true` opt-in. |
| `GET` | `/api/attendance/schedule-groups/:id` | Read one schedule group. |
| `POST` | `/api/attendance/schedule-groups` | Create schedule group. |
| `PUT` | `/api/attendance/schedule-groups/:id` | Update schedule group. |
| `DELETE` | `/api/attendance/schedule-groups/:id` | Soft-delete by setting `is_active=false`. |
| `GET` | `/api/attendance/schedule-groups/:id/members` | List date-aware members. |
| `POST` | `/api/attendance/schedule-groups/:id/members` | Add one or more members, rejecting overlaps. |
| `DELETE` | `/api/attendance/schedule-groups/:id/members/:memberId` | Delete one membership row by id. |
| `GET` | `/api/attendance/scheduler-scopes` | List active scheduler scopes, `includeInactive=true` opt-in. |
| `POST` | `/api/attendance/scheduler-scopes` | Create explicit scheduler scope. |
| `PUT` | `/api/attendance/scheduler-scopes/:id` | Update explicit scheduler scope. |
| `DELETE` | `/api/attendance/scheduler-scopes/:id` | Soft-delete by setting `is_active=false`. |

## Boundary Decisions

| Boundary | Decision |
| --- | --- |
| Existing `attendance_groups` | Not overloaded. Only optional FK reference from schedule group to attendance group. |
| Existing `attendance_group_members` | Not modified. New date-aware table is separate. |
| Scheduling grid | Deferred. The grid must use this scope model later. |
| Scoped non-admin writes | Deferred. This slice defines scope rows and pure matching helper; future write endpoints must enforce it. |
| Operation log | Contract remains documented; no audit write was added here because this slice only creates admin setup surfaces and no grid/bulk schedule mutation. |
| Multitable | Not touched. Future schedule snapshots remain rebuildable outputs, not facts. |
| Data Factory / Bridge Agent | Not touched. |

## Follow-Up Slices

1. Read-only advanced scheduling workbench that consumes schedule groups and
   current assignments.
2. Backend scoped permission enforcement helper for non-admin scheduling writes.
3. Dense grid draft/preview flow that routes every write through conflict guards.
4. Copy/paste and copy previous week/month.
5. Excel import/export with out-of-scope row rejection.
6. Operation-log integration for grid/import/clear/copy actions.
