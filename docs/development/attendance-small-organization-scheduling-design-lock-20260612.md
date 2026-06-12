# Attendance Small-Organization Scheduling Design Lock

Date: 2026-06-12
Status: design lock only; no runtime, migration, route, API, or UI change in
this slice.

## 0. Why This Now

The H2/H2+/A2 lines are closed, and C5 real DingTalk delivery is blocked on
external staging configuration: work-notification agent config, a test recipient,
and a staging auth token. While that external gate is waiting, the safest
independent OPTIONAL line is `小组织挂部门`, because the backend foundation already
exists and the remaining work is to productize it.

This is not a new organization tree. It is a DingTalk-like scheduling cockpit on
top of the existing advanced scheduling substrate:

- `attendance_schedule_groups` is already separate from `attendance_groups`.
- `attendance_schedule_groups.parent_id` already supports small-organization
  nesting.
- `attendance_schedule_groups.department_ref` already stores an opaque
  department reference.
- `attendance_schedule_group_members` already stores date-aware membership.
- `attendance_scheduler_scopes` already supports `scheduleGroupIds`,
  `attendanceGroupIds`, `departments`, and scoped actions.

The lock below turns those latent fields into an implementation sequence without
opening the heavier `调度` / `换班` domains.

## 1. Current Grounding

| Existing asset | Current state | Design consequence |
| --- | --- | --- |
| `attendance_schedule_groups.parent_id` | Nullable FK to the same table, `ON DELETE SET NULL` | Use it for v1 small-organization nesting; do not add a second tree. |
| `attendance_schedule_groups.department_ref` | Nullable `text`, intentionally not a FK | Keep it as an opaque reference; do not hard-bind to one directory source in v1. |
| `attendance_schedule_groups.attendance_group_id` | Optional FK to `attendance_groups` | Keep attendance groups as policy/membership groups; schedule groups are operational scheduling groups. |
| Schedule group routes | CRUD exists; `POST` create is admin-only, `GET` is scoped, `PUT/DELETE` use `edit` scope, member add/delete uses `dispatch` scope | Implementation should harden and expose the existing surface, not invent parallel routes. |
| Advanced scheduling workbench | Read-only summary only | Small-org UI should extend this area, not the basic attendance group admin surface. |
| Scheduler scopes | `departments` match `g.department_ref`; assignment view/dispatch already resolves schedule-group membership | Department-linked small orgs must remain compatible with existing scope semantics. |

## 2. Owner Decisions Locked By This Document

1. **Reuse `attendance_schedule_groups` for v1 small organizations.** No new
   `attendance_small_orgs` table and no alteration of `attendance_groups`.
2. **Keep `department_ref` opaque in v1.** Preferred UI source is synced
   `directory_departments`, but the stored value remains text. The UI may display
   `department_full_path`; the persisted value must be the stable reference
   chosen by the implementation slice, and tests must lock the round trip.
3. **Small-org nesting is operational scheduling structure, not HR authority.**
   `parent_id` controls grouping in the scheduling cockpit; it does not grant
   roles, change payroll departments, or change DingTalk directory sync.
4. **No schedule-write expansion in this line.** Small organization management
   may add/edit groups and members. It must not add grid edits, copy/paste,
   Excel import, dispatch optimization, or shift-swap writes.
5. **Scheduler-scope remains the permission model.** Full `attendance:admin`
   can manage all groups. Scoped actors can only see/edit/dispatch within
   existing `attendance_scheduler_scopes` semantics.

## 3. Hardening Required Before Admin UI

The existing table shape is sufficient, but the small-org UI would make latent
tree fields reachable. The first implementation slice must close these runtime
holes before exposing a tree editor:

| Guard | Required behavior | Why |
| --- | --- | --- |
| Parent org guard | `parentId` must reference an active schedule group in the same org. | Prevent cross-org or inactive-parent hierarchy drift. |
| Self/cycle guard | Reject self-parent and ancestor cycles. | `normalizeAttendanceScheduleGroupInput` currently catches only direct self-parent on update; a UI tree needs full cycle safety. |
| Parent deactivation guard | Deactivating a parent with active children must either reject with a clear code or require an explicit reparent strategy. v1 should reject. | `ON DELETE SET NULL` is irrelevant to soft-delete; silent orphaning would confuse the cockpit. |
| Department reference guard | If a directory department picker is used, store the exact selected reference and preserve already-saved values not present in the current page. | Prevent picker truncation from clearing valid department bindings. |
| Scope guard parity | Non-admin view/edit/dispatch tests must prove department-scoped and scheduleGroupId-scoped actors hit the real branch. | Avoid registry-only scope rows that do not constrain the UI. |

## 4. Product Surface

### 4.1 Admin Cockpit

Place the surface under the existing Advanced scheduling section. It should be a
work-focused hierarchy/table, not a landing page:

- left side or top-level rows: schedule-group tree grouped by `parentId`.
- row columns: name, code, linked attendance group, department, active state,
  member count, assignment count, source.
- row actions: edit group, deactivate group, manage members.
- detail panel: date-aware members with `member | lead | backup`, effective
  window, and source.

### 4.2 Department Picker

The first real picker should only be built if a reliable department source is
available in the current repo/runtime. Candidate source:

- synced `directory_departments` through the existing admin directory surfaces.

If staging/customer does not have directory sync data, the UI must still preserve
and show existing `departmentRef` values as chips/text. It must not silently clear
unknown references.

### 4.3 Copy Boundaries

Visible copy must be honest:

- Say "schedule groups / small scheduling organizations".
- Do not say "HR organization", "payroll department", "DingTalk sync", or
  "automatic dispatch".
- Make clear that schedule facts still come from shift/rotation/fixed/temp
  assignments; small orgs are grouping and responsibility boundaries.

## 5. Implementation Slices

| Slice | Scope | Completion bar |
| --- | --- | --- |
| SO0 parent/department hardening | Backend validation for parent org, cycle, active-parent, parent deactivation, department reference round trip | Real-DB route tests for each negative case; no UI |
| SO1 read/write admin cockpit | Frontend tree/table + edit/deactivate group + member management over existing routes | Web tests with exact PUT/POST/DELETE bodies and no silent truncation |
| SO2 scoped actor smoke | Seed non-admin scoped actor with no central `attendance:admin`; verify view/edit/dispatch reach the scoped branches | Real-DB integration or staging smoke proves scoped branches are reachable |
| SO3 staging closeout | Deploy, create parent + child + department-bound group, add members, verify workbench/scopes, cleanup | PASS stamp + residue=0 before tracker can flip to ✅ |

Each slice is separately gated. SO1 must not start before SO0 because the tree UI
would otherwise expose unsafe `parentId` behavior.

## 6. Tests That Must Exist

Backend:

- parent must belong to same org and be active.
- cycle attempt A -> B -> A returns a stable 422/409 and leaves rows unchanged.
- deactivating a group with active children fails unless a future slice adds an
  explicit reparent operation.
- department-scoped scheduler scope can view/edit only matching
  `department_ref` groups.
- scheduleGroupId-scoped actor cannot edit sibling groups under the same parent.
- member add/delete still requires `dispatch`, not merely `edit`.

Frontend:

- loading existing `parentId` and `departmentRef` hydrates the form without
  clearing unknown references.
- saving group edits sends only the group fields expected by the route.
- deactivation asks for confirmation and does not send DELETE when canceled.
- member management sends exact `userIds`, date window, role, and source.
- scoped actor UI hides or disables actions it cannot perform and the backend
  still enforces the same boundary.

Staging:

- create parent, child, and department-bound child.
- add lead/member rows with effective windows.
- verify advanced scheduling workbench counts and tree membership.
- verify a department-scoped scheduler can see the child and cannot see an
  unrelated department group.
- restore settings/data and assert residue=0.

## 7. Explicitly Out Of Scope

- Dense schedule grid edit.
- Copy/paste or copy previous week/month.
- Excel import/export.
- OA dispatch / staff transfer.
- Shift-swap.
- AI/optimized scheduling.
- Multistore staffing optimizer.
- Payroll or attendance-record recalculation.
- Changing DingTalk directory sync or local user admission.

## 8. Tracker Status

After this document lands, `小组织挂部门` is `🟡 design-locked`, not done. It can
only become ✅ after SO0-SO3 are merged and staging-proven. `调度` and `换班`
remain `⬜ 0`.
