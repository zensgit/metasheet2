# Attendance Advanced Scheduling Group / Scheduler Scope Design

Date: 2026-05-21
Scope: PR1 design lock only. No runtime code, route, migration, frontend, or
staging operation in this slice.

## Summary

DingTalk advanced scheduling treats `排班班组` and `排班人` as load-bearing
concepts:

- `排班班组`: an operator-facing grouping used to batch schedule employees by
  work nature, shift plan, project, or responsibility. It supports Excel batch
  maintenance and recurring report/export decisions.
- `排班人`: delegated scheduler users who may only operate within assigned
  scheduling scope.

MetaSheet currently has `attendance_groups`, `attendance_group_members`, RBAC,
fixed assignments, rotation assignments, conflict save guards, effective
calendar, and audit tables. Those pieces are necessary but not sufficient:
`attendance_groups` represent attendance policy/rule-set ownership, while
advanced scheduling needs an additional operational grouping and scoped
delegation layer.

## Decisions

| Topic | Decision |
| --- | --- |
| Scheduling group ownership | Add a separate `attendance_schedule_groups` model. Do not reuse or overload `attendance_groups`. |
| Relationship to attendance groups | Optional reference from schedule group to `attendance_groups.id`; schedule groups may also exist without an attendance group. |
| Membership | Add date-aware schedule-group membership, separate from `attendance_group_members`. |
| Scheduler scope | Add an attendance scheduling scope table that grants scheduler actions over schedule groups, attendance groups, users, departments, roles, or role tags. |
| RBAC layering | Existing `attendance:admin` remains superuser. New scoped scheduler permissions are checked after coarse RBAC and before scheduling writes. |
| Operation log | Reuse `operation_audit_logs` with attendance-specific `resource_type` / `action` values. Do not create a parallel audit fact table in v1. |
| Multitable boundary | Advanced scheduling can later sync schedule snapshots to private multitable objects, but multitable never becomes the schedule fact source. |
| Dense grid timing | Build read-only grid only after this scope model is locked. |

## Why Not Reuse `attendance_groups`

Existing `attendance_groups` already carries:

- `rule_set_id`
- timezone
- group membership
- effective-calendar group preview behavior
- import/sync mapping through DingTalk group names and codes

Overloading it for `排班班组` would create semantic coupling:

| Need | Why `attendance_groups` is wrong |
| --- | --- |
| Project- or production-line based scheduling group | Not necessarily an attendance policy group. |
| Temporary staffing group for a date range | Attendance group membership may remain stable. |
| Multiple scheduler scopes within one attendance group | `attendance_groups` has no delegated scheduler semantics. |
| Batch import/update of scheduling groups | Existing group import/update semantics are tied to attendance group membership. |
| Per-schedule operation log | Existing group CRUD does not represent schedule edit actions. |

Therefore `attendance_schedule_groups` is a new operational model.

## Proposed Data Model

This is a design contract for future implementation PRs; this PR does not add
migrations.

### `attendance_schedule_groups`

```text
id uuid primary key
org_id text not null default 'default'
name text not null
code text null
description text null
attendance_group_id uuid null references attendance_groups(id)
parent_id uuid null references attendance_schedule_groups(id)
department_ref text null
source text not null default 'manual' -- manual | import | integration
is_active boolean not null default true
created_by text null
updated_by text null
created_at timestamptz default now()
updated_at timestamptz default now()
```

Indexes:

- unique `(org_id, name)` for active names.
- unique `(org_id, code)` where code is not null.
- `(org_id, attendance_group_id)`.
- `(org_id, parent_id)`.

Notes:

- `department_ref` is a string reference in v1 because the repo has multiple
  department/org sources. It must not become a hard foreign key until the
  canonical org-directory model is confirmed.
- `parent_id` supports DingTalk-like small-organization nesting.
- `source` supports Excel import and future integration without conflating
  imported rows with manual rows.

### `attendance_schedule_group_members`

```text
id uuid primary key
org_id text not null default 'default'
schedule_group_id uuid not null references attendance_schedule_groups(id)
user_id text not null
effective_from date null
effective_to date null
role text null -- member | lead | backup
source text not null default 'manual'
created_by text null
updated_by text null
created_at timestamptz default now()
updated_at timestamptz default now()
```

Indexes:

- `(org_id, schedule_group_id)`.
- `(org_id, user_id)`.
- `(org_id, schedule_group_id, user_id, effective_from, effective_to)`.

Contract:

- Membership is date-aware so a future schedule grid can answer "who belonged
  to this scheduling group on this day?"
- Overlap policy for one user in the same schedule group is strict: overlapping
  active membership windows should be rejected or merged by an explicit import
  preview. Do not silently create duplicates.
- Membership does not change `attendance_group_members`.

### `attendance_scheduler_scopes`

```text
id uuid primary key
org_id text not null default 'default'
subject_type text not null -- user | role | role_tag
subject_ref text not null
actions text[] not null -- view | edit | import | export | clear | approve | dispatch
scope jsonb not null
is_active boolean not null default true
created_by text null
updated_by text null
created_at timestamptz default now()
updated_at timestamptz default now()
```

Recommended `scope` shape:

```json
{
  "scheduleGroupIds": [],
  "attendanceGroupIds": [],
  "userIds": [],
  "departments": [],
  "roles": [],
  "roleTags": []
}
```

Contract:

- Empty scope is invalid for scoped schedulers. Only `attendance:admin` may act
  globally.
- `actions` must be explicit; `view` does not imply `edit`, and `edit` does not
  imply `import` or `clear`.
- Role and role-tag subjects use existing RBAC/role context; this table is not
  a replacement for `user_roles`.
- If RBAC tables are degraded, scoped scheduler checks fail closed.

## Permission Model

Future scheduling endpoints should apply two layers:

1. Coarse access:
   - `attendance:admin` or a new broad `attendance:schedule` permission enters
     the scheduling module.
   - `attendance:admin` bypasses scoped checks.
2. Scoped scheduling access:
   - Non-admin users must match an active `attendance_scheduler_scopes` row for
     the requested action and target people/dates/groups.

Target context for scope checks:

```ts
interface ScheduleTargetContext {
  orgId: string
  action: 'view' | 'edit' | 'import' | 'export' | 'clear' | 'approve' | 'dispatch'
  userIds: string[]
  scheduleGroupIds?: string[]
  attendanceGroupIds?: string[]
  departments?: string[]
  roles?: string[]
  roleTags?: string[]
  from?: string
  to?: string
}
```

Rules:

- `view`: all returned rows must be within scope or filtered out.
- `edit` / `clear`: all targeted rows must be within scope; partial writes are
  rejected unless the endpoint explicitly supports per-row results.
- `import`: preview may show out-of-scope rows as rejected; commit must not write
  them.
- `export`: export body must be scoped, not just the UI query.
- `dispatch`: reserved for future optimizer / OA-transfer flow.

## Operation Log Contract

Reuse `operation_audit_logs`.

Recommended values:

| Operation | action | resource_type |
| --- | --- | --- |
| schedule group create/update/delete | `attendance.schedule_group.create/update/delete` | `attendance_schedule_group` |
| schedule group membership import/update | `attendance.schedule_group_members.import/update` | `attendance_schedule_group` |
| scheduler scope create/update/delete | `attendance.scheduler_scope.create/update/delete` | `attendance_scheduler_scope` |
| grid cell edit | `attendance.schedule_grid.edit` | `attendance_schedule_assignment` |
| grid clear | `attendance.schedule_grid.clear` | `attendance_schedule_assignment` |
| copy previous week/month | `attendance.schedule_grid.copy_period` | `attendance_schedule_assignment` |
| Excel import preview/commit | `attendance.schedule_import.preview/commit` | `attendance_schedule_import` |
| temporary line-draw shift | `attendance.temporary_shift.create/update/delete` | `attendance_temporary_shift` |
| dispatch plan preview/commit | `attendance.dispatch.preview/commit` | `attendance_dispatch_plan` |

Minimum metadata:

```json
{
  "orgId": "default",
  "actorId": "user-1",
  "source": "ui|import|api|job",
  "from": "2026-05-01",
  "to": "2026-05-31",
  "targetCounts": {
    "users": 12,
    "dates": 31,
    "cells": 372
  },
  "scope": {
    "scheduleGroupIds": [],
    "attendanceGroupIds": []
  },
  "fingerprintBefore": "...",
  "fingerprintAfter": "...",
  "requestId": "..."
}
```

Do not log raw Excel file contents or secrets.

## API Roadmap

### PR2 read-only descriptors

Before a grid exists, add read-only endpoints:

- `GET /api/attendance/schedule-groups`
- `GET /api/attendance/schedule-groups/:id/members`
- `GET /api/attendance/scheduler-scopes`

All require `attendance:admin` in PR2. Scoped non-admin access comes only after
the scope checker is implemented.

### PR3 scope checker

Add helper:

```ts
canScheduleForScope(db, actorId, targetContext, options)
```

Test:

- admin global pass
- user subject pass
- role subject pass
- role tag pass
- out-of-scope read filters or rejects
- out-of-scope write rejects
- RBAC schema degraded fails closed for scoped scheduler

### PR4 read-only dense workbench

Uses:

- `attendance_schedule_groups`
- current fixed and rotation assignment readers
- effective calendar explanation
- existing conflict diagnostics

No editing yet.

### PR5 write paths and logs

Only after PR4 proves the read model:

- batch grid edit
- clear
- copy previous week/month
- operation-log writes
- backend conflict guard remains authoritative

## Out of Scope

- Excel import/export implementation.
- Temporary line-draw shift implementation.
- Dispatch optimizer.
- Mobile scheduling UI.
- Multitable schedule snapshot object.
- Any Data Factory / Bridge Agent work.

## Review Checklist

Claude / reviewer should check:

- `attendance_schedule_groups` is separate from `attendance_groups`.
- `attendance_group_members` remains unchanged by schedule-group membership.
- scoped scheduler checks fail closed when RBAC is unavailable.
- every future write operation has a named operation-log action.
- no multitable object is proposed as schedule fact source.
- no client-only validator becomes scheduling truth.
