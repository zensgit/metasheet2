# Attendance Group Owner/Sub-Owner Design

Date: 2026-05-29
Branch: `codex/attendance-group-owner-design-1924-20260529`
Status: design lock only

## 1. Purpose

This document locks the owner / sub-owner track for the DingTalk-aligned attendance group admin work in `#1924`.

The reference experience has a named attendance group responsible-person section. MetaSheet now has a stronger attendance group manager, but it still has no group owner model. This is not a UI-only gap: owner/sub-owner changes cross storage, permission semantics, route guards, member counts, and delegated admin scope.

This document does not authorize runtime code, schema, route, permission, migration, OpenAPI, frontend, or test changes. A future runtime PR must be explicitly opted in.

## 2. Lineage

| Link | State | Relevance |
| --- | --- | --- |
| `docs/development/attendance-group-admin-ux-parity-design-20260527.md` | merged design lock | Listed "Should attendance groups have owner/sub-owner permissions?" as open question #1. This document answers the shape of that track. |
| `#1952` and later #1924 slices | merged runtime | Built the production list-detail group manager and read-only adjacent cards. Owners stayed intentionally deferred. |
| `#2097` | merged runtime | Added the read-only Punch method drawer while preserving the same rule: no fake group-owned controls without a backend contract. |

## 3. Current Baseline

All code citations were verified on `origin/main` at `4c7bf8e5`.

| Area | Current state | Evidence |
| --- | --- | --- |
| Group row shape | `mapAttendanceGroupRow` returns id, org, name, code, timezone, rule set, description, member count, attendance type, timestamps. It returns no owner or sub-owner field. | `plugins/plugin-attendance/index.cjs:7355` |
| Group storage | `attendance_groups` stores `id`, `org_id`, `name`, `code`, `timezone`, `rule_set_id`, `description`, timestamps; a later migration adds only `attendance_type`. | `packages/core-backend/src/db/migrations/zzzz20260204123000_create_attendance_groups.ts:13`, `packages/core-backend/src/db/migrations/zzzz20260529213000_add_attendance_group_type.ts:12` |
| Member storage | `attendance_group_members` stores attendance targets (`org_id`, `group_id`, `user_id`) and enforces uniqueness on `(org_id, group_id, user_id)`. | `packages/core-backend/src/db/migrations/zzzz20260204123000_create_attendance_groups.ts:41`, `:55` |
| Group API guard | Attendance group list/detail/create/update/delete/member/fixed-schedule routes are guarded by `attendance:admin`. | `plugins/plugin-attendance/index.cjs:26080`, `:26142`, `:26182`, `:26248`, `:26353`, `:26384`, `:26429`, `:26519` |
| Permission helper | Admin access is global: `hasAttendanceAdminAccess` accepts global admin or `attendance:admin`; there is no group-scoped owner check. | `plugins/plugin-attendance/index.cjs:14624` |
| Admin onboarding | Admin user creation can add a new user to an attendance group, but this writes membership only, not owner/delegated-manager state. | `packages/core-backend/src/routes/admin-users.ts:3262` |
| Current frontend framing | The group detail still says owner/sub-owner controls are deferred in the Advanced controls card. | `apps/web/src/views/AttendanceView.vue:9092` |

## 4. Design Decision

Owner/sub-owner should be modeled as a separate attendance group management relation, not as:

- a column on `attendance_groups`;
- a flag on `attendance_group_members`;
- a global user role;
- a rule set attribute;
- a schedule group capability;
- a frontend-only list of user IDs.

Recommended future storage shape:

```text
attendance_group_managers
- id uuid primary key
- org_id text not null
- group_id uuid not null references attendance_groups(id) on delete cascade
- user_id text not null
- role text not null check (role in ('owner', 'sub_owner'))
- created_by text null
- created_at timestamptz default now()
- updated_at timestamptz default now()

unique (org_id, group_id, user_id, role)
index (org_id, group_id)
index (org_id, user_id)
```

The future product can choose whether a group must have exactly one owner. V1 should not enforce "at least one owner" until the migration, backfill, and admin escape hatch are designed.

## 5. Semantic Rules

1. An owner is not automatically an attendance member.
2. A sub-owner is not automatically an attendance member.
3. Attendance member count must continue to count only `attendance_group_members`.
4. Fixed-schedule preview/apply targets must continue to enumerate attendance members only.
5. Owner/sub-owner display names should reuse the existing user picker / batch-resolve machinery, but the stored relation must remain user-id based.
6. Group owner roster changes must be audit-worthy; the future route should return created/removed manager rows, not silently fold them into group basic info.
7. Delegated permission is a later phase. A visible owner roster alone must not grant route access until backend guards are changed and tested.

## 6. Permission Model Options

| Option | Meaning | V1 decision |
| --- | --- | --- |
| Display-only roster | `attendance:admin` manages owner/sub-owner rows; no delegated route access. | Recommended first runtime step. It is honest and useful without reopening every group route guard. |
| Scoped delegation | Owner/sub-owner can manage only their own group sections. | Deferred. Requires a `canManageAttendanceGroup(userId, groupId, action)` helper, route-by-route guard changes, and denial tests. |
| Global RBAC role | Assign a normal global role such as `attendance_group_owner`. | Not recommended. It loses the group boundary and becomes another global admin role. |

If scoped delegation is later approved, the minimum safe action matrix should start narrow:

| Action | Owner | Sub-owner | Notes |
| --- | --- | --- | --- |
| View group and members | yes | yes | Must be scoped to assigned groups only. |
| Add/remove members | maybe | maybe | Needs product decision because it changes attendance targets. |
| Edit basic info | maybe | no | Renaming/code/timezone/rule-set changes affect policy. Keep admin-only until explicitly approved. |
| Fixed-schedule preview | yes | yes | Read-only preview can be low risk if group-scoped. |
| Fixed-schedule apply/rebuild/clear | maybe | no | Writes schedule assignments; should stay admin-only until evidence says otherwise. |
| Manage owner roster | admin only | admin only | Prevent privilege escalation. |
| Settings, punch policy, rule sets, holidays, imports, reports | no | no | These are workspace/module-level surfaces. |

## 7. Runtime Slice Plan

### Slice O1: Backend Owner Roster, Admin-Only

Allowed:

- migration for `attendance_group_managers`;
- list/add/remove owner roster routes under `/api/attendance/groups/:id/managers`;
- `attendance:admin` guard only;
- mapper support for owner counts or a nested `managers` payload if the route owns it;
- backend unit tests for UUID validation, uniqueness, role validation, delete cascade assumptions, and no member-count pollution.

Not allowed:

- delegated access;
- changes to existing group/member/fixed-schedule route guards;
- changes to `attendance_group_members`;
- changes to fixed-schedule target enumeration;
- punch policy, rule set, holiday, import, report, or schedule group changes.

### Slice O2: Frontend Owner Section

Allowed after O1 lands:

- an Owner / Sub-owner panel in the selected attendance group detail;
- user picker-first add flow;
- resolved name/email labels like the People section;
- zero impact on member count and fixed-schedule target labels;
- regression tests proving owner add/remove does not call member routes or settings/punch/record routes.

Not allowed:

- disabled fake delegated-admin controls;
- mobile promises;
- implicit member creation;
- group owner copy/export semantics unless separately designed.

### Slice O3: Scoped Delegation

Only after a separate explicit opt-in:

- add a backend helper that checks direct global admin first, then group manager rows;
- update selected routes one by one with action-specific permissions;
- add 403/404 behavior that does not leak other groups;
- add audit/event evidence for delegated writes;
- add tests for owner, sub-owner, unrelated user, global admin, and inactive/deleted group cases.

## 8. Test Matrix

| ID | Requirement | Test target |
| --- | --- | --- |
| OW1 | Owner/sub-owner rows are stored separately from attendance members. | Backend migration/route tests. |
| OW2 | Member count and fixed-schedule target counts are unchanged when owners are added. | Backend route unit + frontend regression. |
| OW3 | Adding the same user/role twice is idempotent or returns a clear conflict, per chosen route contract. | Backend route test. |
| OW4 | Invalid group UUID and invalid role return existing error style. | Backend route test. |
| OW5 | Owner roster UI uses picker labels and never writes `attendance_group_members`. | Frontend regression. |
| OW6 | Owner roster UI does not expose delegated-permission controls in O2. | Frontend DOM assertion. |
| OW7 | O3 scoped delegation denies unrelated users and does not leak groups. | Backend route tests for every guarded route. |
| OW8 | O3 cannot let owners manage owner rosters unless explicitly approved. | Backend route test. |
| OW9 | No punch, attendance event, record, import, rule set, holiday, or schedule-group write is introduced by O1/O2. | Reviewer diff check + targeted route call assertions where practical. |

## 9. Explicitly Deferred

- true delegated owner/sub-owner permissions;
- owner/sub-owner copy/export semantics;
- owner/sub-owner mobile editing;
- department or role-group owner assignment;
- approval-flow escalation to group owner;
- notifying owners on anomalies or missing punch;
- punch method, Wi-Fi, device, photo, face, field-work policy ownership;
- multi-shift weekly authoring;
- comprehensive-hours writes;
- K3/Data Factory/external integration.

## 10. Acceptance For This Design

This design is complete when:

- it records that there is no owner/sub-owner storage or route today;
- it separates owner roster metadata from attendance membership;
- it recommends a future `attendance_group_managers` relation rather than overloading members or global roles;
- it keeps first runtime work admin-only and defers scoped delegation;
- it defines the minimum route and frontend slices;
- it states that member counts and fixed-schedule targets must remain unchanged;
- it adds no runtime code, tests, schema, routes, permissions, OpenAPI, migrations, or production writes.
