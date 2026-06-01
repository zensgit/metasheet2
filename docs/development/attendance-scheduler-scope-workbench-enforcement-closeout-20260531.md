# 考勤管理员工作台 / 排班管理范围 closeout

> Date: 2026-05-31
> Status: closeout / TODO refresh
> Baseline: `origin/main` `4f93be431` after scheduler-scope PRs through #2165.

## 1. Why this closeout exists

The original workbench design-lock and enforcement design-lock were intentionally frozen before implementation:

- `docs/development/attendance-scheduler-scope-workbench-design-lock-20260529.md`
- `docs/development/attendance-scheduler-scope-enforcement-design-lock-20260530.md`

Those documents are still useful as decision records, but their TODO sections no longer describe the current shipped state. This closeout is the current single-page status for the workbench + runtime enforcement line.

## 2. Current shipped state

| Area | Status | Evidence |
|---|---:|---|
| Workbench registry list | Done | #2067 |
| Workbench create | Done | #2108 |
| Workbench edit + deactivate | Done | #2123 |
| Six target controls | Done | `scheduleGroupIds`, `attendanceGroupIds`, `userIds`, `departments`, `roles`, `roleTags` are preserved in the form payload |
| Wire-vs-fixture target mapping tests | Done | frontend regression tests cover all 6 scope keys |
| Targeted web gate | Done | `attendance-web-guard` covers attendance admin regressions + anchor nav |
| Scheduler-scope local guard | Done | `assertAttendanceSchedulerScopeAllowed` in `plugins/plugin-attendance/index.cjs` |
| Read filtering | Done | schedule groups, schedule group members, shift assignments, and rotation assignments are filtered for scoped `view` actors |
| Member dispatch | Done | schedule group member add/delete use `dispatch` scope |
| Schedule group edit/deactivate | Done | schedule group update/delete use `edit` scope |
| Shift assignment dispatch | Done | create/update/delete resolve user/date schedule-group facts before write |
| Rotation assignment dispatch | Done | create/update/delete resolve user/date schedule-group facts before write |
| Fixed-schedule operations | Done | clear/apply/rebuild require matching `clear` and/or `dispatch` scope |
| Request approval | Done | request approval uses `approve` scope before write |
| Export | Done | scoped record export checks target users/date range before reading records |
| Sync import prepare | Done | scoped actors can prepare only when they have `import` scope intent |
| Sync import preview | Done | row targets are checked before rule evaluation |
| Sync import commit | Done | row targets are checked before token consumption and writes |
| Legacy sync import | Done | row targets are checked before rule evaluation and writes |
| Sync import idempotency replay | Done | scoped replay is delayed until target scope passes and must match `created_by` |

## 3. Open TODO

| ID | Item | Status | Notes |
|---|---:|---|---|
| C1 | Update stale UI banner | Done in this closeout slice | The banner now says enforcement is partial and names deferred surfaces. |
| C2 | Keep a current closeout/TODO document | Done in this closeout slice | This file is the current status page. |
| C3 | Verify delegated non-admin UX end to end | Open | Backend scoped access is broad, but the frontend is still primarily an admin surface. Test a real scoped actor path before calling delegated UX complete. |
| C4 | Polish `departments`, `roles`, and `roleTags` target inputs into true data-source pickers | Open | Current controls preserve values as chips/free text. This is acceptable for function, but not the final ergonomic picker UX. |
| C5 | Adjust banner again after async/job surfaces are designed | Open | Do not claim global scheduler-scope enforcement until deferred surfaces are explicitly handled or intentionally excluded. |

## 4. Deferred design-lock items

These remain out of the shipped scheduler-scope line and should not be folded into a small cleanup PR:

- Async import preview / commit jobs
- Import job polling and job ownership semantics
- Import batches, batch items, batch CSV export
- Import rollback
- Import templates and upload channel
- Attendance integrations and integration runs
- Any central RBAC / auth / `plugin-integration-core` changes

The reason is not only implementation size. These surfaces need separate decisions for target ownership, replay/idempotency, historical batch visibility, rollback authority, and whether a scoped actor should see artifacts created by another actor.

## 5. Suggested next slice

Recommended order:

1. Delegated UX smoke: run the admin workbench with a real scoped non-admin actor and record which entry points are usable without `attendance:admin`.
2. Picker polish: replace free-text `departments` / `roles` / `roleTags` with repo-backed selectors if those data sources are available in AttendanceView.
3. Async import design-lock: decide ownership and visibility semantics before opening jobs/batches/rollback to scheduler-scoped actors.

Until step 3 is designed, the correct product wording is **partial runtime enforcement**, not "all scheduler-scope permissions are active".
