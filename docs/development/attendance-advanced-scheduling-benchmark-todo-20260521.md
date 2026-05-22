# Attendance Advanced Scheduling Benchmark TODO

Date: 2026-05-21
Scope: planning / benchmark only. No runtime code, migration, route, API, or UI change in this slice.
Source focus: DingTalk handbook advanced scheduling pages under
`https://alidocs.dingtalk.com/i/p/Y7kmbokZp3pgGLq2/docs/...`, read from the
left-hand "考勤高级版" menu and the visible right-hand detail pages.

## Reading Coverage

The DingTalk handbook body is rendered through an embedded preview frame, so the
benchmark was read through visible page content and screenshots rather than a
full text export. Covered pages:

| Page | URL observed | Details read |
| --- | --- | --- |
| `管理员设置固定班制考勤` | `pq7N1kjGYznWyLOOOwxm8O43vrPX95oA` | fixed workday setup, multiple attendance time rules, shift selection, legal-holiday auto rest, special dates |
| `电脑端排班` | `OBld...` / advanced menu detail | schedule export, day/cycle scheduling, copy/paste, copy previous week/month, batch schedule, Excel import, clear schedule, line-draw temporary shift, fullscreen, statistics, comprehensive-hours check |
| `排班报表` | `Z0LYK27vwxp80YeBXABOWo5Olb4md9eP` | report homepage, department/person/time-dimensional visual reports |
| `小组织管理` | `6wPdlBDrQk4JYPj2ynx2VXKx72oEGeL5` | associate attendance group/class with organization tree; create/edit/delete small org groups |
| `排班规则` | `qXomz1wAyjKVXPMpQ7bEV3Y9pRBx5OrE` | custom schedule rules per attendance group; multi-shift day, temporary line scheduling, daily/weekly/monthly working-hour caps |
| `排班人` | `B6L5QAmawMPJMaOKXZ4zJq1z09lnK3kb` | assign schedulers by role/position/member and restrict scheduling scope |
| `如何新增排班班组` | `bxgzX5wq4YoJPb597wK5WRy2OB79ALPD` | group employees by work nature, shift plan, or responsibility; Excel batch import/update; role-scoped view/edit; recurring export for payroll/performance decisions |
| `调度` | `lo1YvX0prG98kexQpv2KVPw7xzbmLdEZ` | batch staff transfer through OA approval; AI/optimized scheduling plan; production-line support scenarios |
| `排班权限设置` | `k2wz1jPpZ30Woa5Bj49EJNnvrL4A6dxE` | assign scheduling permissions by actual role/need and control who can operate schedules |
| `操作日志` | `65ALkBedOKwVBzXyrnOZVZq43Nxzop2P` | keep schedule operation records for audit/compliance, leave dispute handling, permission-abuse or mistake investigation |

Left-hand advanced scheduling menu also includes `手机端排班`,
`排班周期`, `高级排班调度设置`, and `插件中心`; these remain follow-up pages for
full visual capture before implementation PRs.

## DingTalk Capability Map

| Domain | DingTalk capability | Product implication |
| --- | --- | --- |
| Shift catalog | Named shifts, time windows, multiple attendance time rules | A reusable shift catalog is the scheduling primitive. |
| Fixed schedule | Standard workday + selected weekdays + special dates | Fixed schedules are the easy mode but still interact with holidays. |
| Schedule workbench | Day scheduling, cycle scheduling, copy/paste, copy previous week/month | Real scheduling work needs a dense grid, not only CRUD forms. |
| Bulk operations | Batch by group, shift, day, person; Excel import; clear by person/date | High-volume operators need bulk fill and rollback-like clearing. |
| Temporary scheduling | Line-draw scheduling creates a temporary shift without pre-creating a catalog item | One-off staffing changes need lightweight overlays. |
| Schedule group | Group employees by work nature, shift plan, org responsibility; Excel update | Scheduling groups are not identical to org departments. |
| Scheduler role | Assign scheduling responsibility by role/position/member and scope | Scheduling authority is delegated and scoped. |
| Rules | Multi-shift day, temporary line schedule, daily/weekly/monthly hour caps | The rule layer constrains both manual and automated scheduling. |
| Cycle | Repeating cycle scheduling | Rotation sequence needs a calendar-aware cycle surface. |
| Dispatch | OA-approved staff transfer and AI/optimized scheduling plans | Advanced scheduling includes planning/optimization, not just saved rows. |
| Reports | Department/person/time visual reports and export | The schedule itself needs analytics before attendance is even calculated. |
| Governance | Permission settings and operation logs | Every schedule change must be attributable and reviewable. |
| Plugins | Comprehensive-hours plugin validates hour caps at save time | Extensibility points matter for vertical labor models. |

## Current MetaSheet Attendance State

| Existing MetaSheet capability | Status | Evidence anchor |
| --- | --- | --- |
| Shift catalog and fixed shift assignments | Covered | `AttendanceView.vue` scheduling admin + assignment routes |
| Rotation rules and rotation assignments | Covered | `attendance-rotation-sequence-preview-*`, `attendance-rotation-assignment-preview-*` |
| Effective calendar resolver | Covered | `attendance-effective-calendar-*`, calendar policy resolver/admin UI |
| Group rule-set preview | Partial | `attendance-effective-calendar-group-ruleset-*`; intentionally only `groupId` preview, not full `userId` calc-chain |
| Conflict preview and save guard | Covered | `attendance-schedule-conflict-preview-*`, `attendance-scheduling-conflict-save-*` |
| Daily and period report sync to multitable | Covered | `attendance-report-records-*`, `attendance-report-period-rollup-*`, report sync jobs |
| Formula / period formulas | Covered | formula hardening and period-summary formula docs |
| Schedule dense grid | Missing | Current admin form is CRUD-oriented, not spreadsheet-like scheduling. |
| Copy/paste and copy week/month | Missing | No scheduling grid clipboard model yet. |
| Schedule Excel import/export | Missing | Report export exists; schedule import/export is separate. |
| Schedule groups distinct from org departments | Partial | Attendance groups exist, but DingTalk-style scheduling groups with batch import/edit scope are not first-class. |
| Scheduler scoped permissions | Partial | Admin roles exist, but scheduling-person scope is not first-class. |
| Operation log for schedule changes | Partial | Audit infrastructure exists, but advanced scheduling operation log surface is not complete. |
| Temporary line-draw shifts | Missing | No one-off shift overlay model yet. |
| Dispatch optimization | Missing | No OA transfer / optimized scheduling planner. |
| Mobile scheduling | Missing | Existing attendance page is responsive, but no dedicated mobile scheduling flow. |

## Benchmark Verdict

We can match DingTalk's advanced scheduling only if the next work moves beyond
CRUD forms. The differentiator should not be a DingTalk clone; it should combine
DingTalk-like operator speed with MetaSheet strengths:

1. Explainable schedule chain:
   every cell explains whether it came from fixed assignment, rotation, temporary
   overlay, calendar policy, group rule set, or manual edit.
2. What-if preview before save:
   batch schedule changes show affected people/dates, conflicts, working-day
   changes, report sync impact, and payroll-period impact before persistence.
3. Multitable-native reporting:
   schedule snapshots, daily records, and period summaries can be viewed,
   filtered, formula-extended, and audited in private multitable objects.
4. Strong governance:
   permissions, operation logs, and backend conflict guards are first-class, not
   just frontend warnings.

## Proposed PR Roadmap

### PR0 - Benchmark closeout (this document)

Deliver a product/technical benchmark and lock the sequence below. No code.

### PR1 - Scheduling group and scheduler-scope design lock

Goal: decide the data boundary for DingTalk-like `排班班组` and `排班人`.

Must answer:

- Are scheduling groups separate from `attendance_groups`, or a typed extension?
- How are scheduler scopes represented: departments, attendance groups,
  scheduling groups, users, roles, role tags?
- Which write paths need operation-log events?
- What is the no-migration minimal slice, and where is migration unavoidable?

Deliverables:

- design MD
- verification MD
- no runtime change unless a tiny read-only descriptor is needed

### PR2 - Read-only advanced scheduling workbench

Goal: dense grid over date x user/group, reading current effective schedule.

Scope:

- user/group/date filters
- fixed assignment + rotation + effective calendar explanation per cell
- conflict badges from existing diagnostics
- no editing yet

This is the safest bridge from current CRUD forms to DingTalk-style scheduling.

### PR3 - Grid edit draft and preview

Goal: edit grid cells in draft mode and preview impact before save.

Scope:

- assign existing shift to selected cells
- clear selected cells
- preview affected rows and conflict diagnostics
- save through existing assignment APIs or a new narrow batch endpoint

Boundary:

- no temporary shift creation yet
- no Excel import yet

### PR4 - Copy/paste and copy previous period

Goal: match high-frequency DingTalk operator workflows.

Scope:

- copy/paste selected cells
- copy previous week
- copy previous month
- deterministic preview before save
- undo-like clear for just-created draft changes before persistence

### PR5 - Schedule import/export

Goal: Excel-style bulk handoff.

Scope:

- export schedule grid template
- import into draft grid
- row-level validation and error report
- no direct write on import until preview passes

### PR6 - Temporary line-draw shift overlay

Goal: support one-off line scheduling without pre-creating a shift.

Design boundary:

- temporary shift overlay must explain itself in effective calendar.
- overlay must not pollute the reusable shift catalog.
- export/report must show both the temporary label and normalized work minutes.

### PR7 - Scheduler permissions and operation log

Goal: match governance capabilities.

Scope:

- scheduler role/scope assignment
- scoped read/write enforcement on scheduling endpoints
- operation log for create/update/delete/batch/import/copy/clear
- audit surface in admin UI

### PR8 - Schedule analytics and multitable snapshots

Goal: exceed DingTalk report usefulness.

Scope:

- schedule-plan snapshot object, distinct from attendance facts and report records
- department/person/time pivots
- shift coverage, hour totals, conflict counts
- private multitable views and formulas

### PR9 - Dispatch optimization preview

Goal: exceed manual scheduling with explainable suggestions.

Scope:

- optimization inputs: required coverage, user availability, hour caps, skills/tags
- generated plan stays draft until approved
- every suggestion includes an explanation and constraint score
- OA approval / transfer workflow is a separate integration slice

## Hard Boundaries

- Stay focused on attendance; Data Factory / Bridge Agent work is out of this
  window.
- Do not let multitable objects become the attendance fact source.
- Do not write directly to `meta_*`.
- Do not bypass existing scheduling conflict save guards.
- Do not add client-only validators that drift from backend schedule truth.
- Staging/live evidence must be explicitly authorized and must not fabricate
  pass results if credentials or seed data are missing.

## Near-Term Recommendation

Start with PR1, not PR2. The DingTalk pages show that `排班班组` and `排班人`
are load-bearing concepts, not cosmetic UI labels. If we build a grid before
deciding scheduler scope and scheduling-group ownership, later permission and
audit fixes will be expensive.

Recommended PR1 title:

```text
docs(attendance): lock advanced scheduling group and scheduler scope
```

Recommended Claude review focus for PR1:

- Whether scheduling group is safely separated from org department and
  attendance group.
- Whether scheduler scope can enforce both read and write operations.
- Whether operation-log requirements cover batch/import/copy/clear.
- Whether the roadmap avoids hidden fact-source or multitable-boundary drift.
