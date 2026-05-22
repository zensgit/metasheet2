# Attendance Advanced Scheduling Read-Only Workbench Development

Date: 2026-05-22
Branch: `codex/attendance-advanced-scheduling-readonly-workbench-20260522`

## Summary

This slice adds the first DingTalk-style advanced scheduling workbench surface
on top of the PR1 schedule-group foundation. It is intentionally read-only:
operators can see coverage and planning signals across schedule groups, shifts,
rotation rules, active assignments, scheduler scopes, and effective-calendar
boundaries, but this slice does not create or edit schedule data.

## Changed Files

| File | Change |
| --- | --- |
| `plugins/plugin-attendance/index.cjs` | Adds a pure `buildAttendanceAdvancedSchedulingWorkbench()` summarizer and `GET /api/attendance/advanced-scheduling/workbench`. |
| `apps/web/src/views/AttendanceView.vue` | Adds the admin workbench panel under Scheduling with metrics, diagnostics, and schedule-group coverage table. |
| `apps/web/src/views/attendance/useAttendanceAdminRail.ts` | Adds `Advanced scheduling` as the first Scheduling nav item. |
| `packages/core-backend/tests/unit/attendance-advanced-scheduling-workbench.test.ts` | Locks summarizer semantics and route read-only/admin contract. |
| `apps/web/tests/attendance-admin-anchor-nav.spec.ts` | Updates nav and quick-jump coverage for the new section. |
| `apps/web/tests/attendance-admin-regressions.spec.ts` | Verifies the workbench renders read-only data and no Create/Edit/Delete controls. |
| `docs/development/attendance-advanced-scheduling-readonly-workbench-development-20260522.md` | This development note. |
| `docs/development/attendance-advanced-scheduling-readonly-workbench-verification-20260522.md` | Verification evidence for this slice. |

## Backend Contract

New route:

```text
GET /api/attendance/advanced-scheduling/workbench?from=YYYY-MM-DD&to=YYYY-MM-DD
```

Guard:

```text
attendance:admin
```

The route reads:

- `attendance_schedule_groups`
- `attendance_schedule_group_members`
- `attendance_scheduler_scopes`
- `attendance_shifts`
- `attendance_rotation_rules`
- `attendance_shift_assignments`
- `attendance_rotation_assignments`

It writes nothing. There is no sibling `POST`, `PUT`, or `DELETE` route for the
workbench path.

## Workbench Payload

The response is a snapshot:

- `summary`: counts for groups, members, scheduler scopes, shifts, rotation
  rules, assignments, assigned users, and diagnostics.
- `scheduleGroups.items`: active schedule groups enriched with member count,
  assigned-user count, shift-assignment count, and rotation-assignment count.
- `diagnostics`: planning signals for empty groups, assigned users without
  schedule-group membership, multi-group users, mixed shift/rotation assignment
  users, and scheduler scopes pointing at inactive or missing groups.
- `metadata.readOnly=true`: explicit frontend and reviewer signal.

## Read-Only Boundary

| Boundary | Decision |
| --- | --- |
| Schedule writes | Not added. Existing shift/rotation/assignment forms remain the only write UI. |
| Grid editing | Not added. Draft grid/edit preview remains the next product slice. |
| Migration | Not added. This consumes PR1 tables. |
| `attendance_*` facts | No new fact table writes. Reads stay inside attendance plugin routes. |
| `meta_*` | Not touched. |
| Multitable | Not touched. |
| Data Factory / Bridge Agent | Not touched. |

## Frontend Placement

The panel is placed as the first item in the existing admin `Scheduling` rail
group. This makes it the overview for the existing lower-level Scheduling
sections:

1. Advanced scheduling
2. Rotation Rules
3. Rotation Assignments
4. Shifts
5. Assignments
6. Holidays

The UI is deliberately operational rather than decorative: compact metrics,
warning diagnostics, and a table of schedule-group coverage. The only button in
the panel reloads the snapshot.

## Diagnostics Semantics

| Diagnostic | Meaning |
| --- | --- |
| `schedule_group_without_members` | An active schedule group has no effective members in the selected range. |
| `assignment_without_schedule_group` | A user has an active shift or rotation assignment but no effective schedule-group membership. |
| `user_multiple_schedule_groups` | A user belongs to more than one schedule group in the selected range. |
| `user_mixed_assignment_kinds` | A user has both shift and rotation assignment rows; effective-calendar resolution still decides day-level precedence. |
| `scheduler_scope_unknown_schedule_group` | A scheduler scope references a schedule group not present in the active snapshot. |

## Follow-Up

Next slice should build draft/grid preview on top of this read-only overview:

- dense date x user/group grid
- draft cell edits against existing shifts
- clear selected cells
- preview conflicts and effective-calendar changes
- save through existing guarded assignment APIs or a narrow batch endpoint
