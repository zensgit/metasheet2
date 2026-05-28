# Attendance Group Admin UX Parity Design

Date: 2026-05-27
Branch: `codex/attendance-group-admin-ux-design-20260527`
Status: design lock only

## 1. Intent

This document locks the first MetaSheet attendance-group admin UX improvement inspired by the locally reviewed reference admin manual page for attendance group creation and editing.

The useful pattern is not "copy every reference capability." The useful pattern is:

1. Make attendance groups the operator's primary object.
2. Let the operator create or select a group first.
3. Edit the group's sections in one coherent detail surface.
4. Show unsupported or separately configured capabilities as summaries and links, not as fake controls.

This design is docs-only. It does not unlock runtime implementation, backend schema, permissions, migrations, punch-device integration, face/photo verification, or schedule-calculation changes.

## 2. Current MetaSheet Surface

All code citations were verified on `origin/main` at `a04758c2c`.

| Area | Current state | Evidence |
| --- | --- | --- |
| Group shape | Existing attendance group rows expose `id`, `orgId`, `name`, `code`, `timezone`, `ruleSetId`, `description`, timestamps. | `plugins/plugin-attendance/index.cjs:7275` |
| Group CRUD | Existing admin routes already support list, detail, create, update, and delete. | `plugins/plugin-attendance/index.cjs:25216`, `plugins/plugin-attendance/index.cjs:25269`, `plugins/plugin-attendance/index.cjs:25301`, `plugins/plugin-attendance/index.cjs:25364`, `plugins/plugin-attendance/index.cjs:25452` |
| Member CRUD | Existing admin routes already support member list, add, and remove. Add accepts `userId` or `userIds`, de-duplicates with `ON CONFLICT DO NOTHING`. | `plugins/plugin-attendance/index.cjs:25483`, `plugins/plugin-attendance/index.cjs:25528`, `plugins/plugin-attendance/index.cjs:25586` |
| Admin navigation | Attendance groups and group members are two separate admin sections under the Organization nav group. | `apps/web/src/views/attendance/useAttendanceAdminRail.ts:21`, `apps/web/src/views/attendance/useAttendanceAdminRail.ts:169`, `apps/web/src/views/attendance/useAttendanceAdminRail.ts:212` |
| Production admin UI | The current production surface is a form plus table for groups, followed by a separate member-management block. | `apps/web/src/views/AttendanceView.vue:2949`, `apps/web/src/views/AttendanceView.vue:2960`, `apps/web/src/views/AttendanceView.vue:3021`, `apps/web/src/views/AttendanceView.vue:3038` |
| Extracted component | `AttendanceRulesAndGroupsSection.vue` contains a similar form/table and member block, with focused frontend tests, but it is not the production admin surface today. | `apps/web/src/views/attendance/AttendanceRulesAndGroupsSection.vue:664`, `apps/web/src/views/attendance/AttendanceRulesAndGroupsSection.vue:755`, `apps/web/tests/AttendanceRulesAndGroupsSection.spec.ts:189` |

## 3. Product Observation From The Manual

The reviewed local manual page presents attendance-group work as a guided object configuration, not as two unrelated tables. The recurring operator-friendly traits are:

- Create group first, then complete sections.
- Keep group name and member scope visible.
- Treat work-time mode, schedule mode, punch method, overtime, field work, rest-day punch, makeup, photo, and face verification as named sections.
- Give each section a simple "set/edit" entry point.
- Avoid requiring operators to understand storage tables or internal rule IDs before they can start.

MetaSheet should adopt the interaction model while respecting the current MetaSheet domain boundary.

## 4. Hard Boundaries

The first runtime slice that follows this design must stay inside these boundaries:

1. No new backend field, table, migration, route, permission, or write path.
2. No attendance fact writes. Only the existing attendance-group and attendance-group-member CRUD may be called.
3. No punch hardware, Wi-Fi, geofence, photo, face-recognition, or device enrollment implementation.
4. No group owner, sub-admin, or delegated permission model.
5. No schedule-calculation change and no automatic shift matching change.
6. No `attendance_schedule_groups` semantic reuse. Attendance groups remain policy and membership groups; schedule groups remain scheduling workbench groups.
7. No fake support copy. If a reference-only capability is not backed by existing MetaSheet data, the UI must say it is not configured or handled elsewhere.
8. No PR6/reporting changes, no K3/Data Factory/external integration work.

Any item above requires a separate design and explicit opt-in.

## 5. UX Contract

### 5.1 Entry

The admin rail keeps one Organization entry named Attendance Groups. Group Members should become a subsection of the selected group detail, not a separate equal-weight destination for normal use.

Implementation may keep `ATTENDANCE_ADMIN_SECTION_IDS.groupMembers` as a compatibility anchor, but the user-facing flow should prefer:

`Admin Center -> Organization -> Attendance Groups -> select/create group -> detail sections`

### 5.2 List Pane

The list pane should show:

- Group name.
- Code.
- Timezone.
- Linked rule set label or "Default rule".
- Member count if it can be obtained without a new backend contract; otherwise omit rather than invent.
- Last updated time if already available.
- Primary Create Group button.

Selecting a row opens the detail pane. Editing should not require scrolling past the list table.

### 5.3 Detail Pane Sections

The selected group detail should be sectioned like an operator checklist:

| Section | V1 behavior | Backend contract |
| --- | --- | --- |
| Basic info | Edit name, code, timezone, rule set, description. Sticky save/cancel. | Existing group POST/PUT only. |
| People | Add/remove members with picker-first UX. Bulk user IDs stay available as secondary power-user input. | Existing member list/add/remove only. |
| Rule policy | Show linked rule set and default-rule fallback. Provide a navigation hint to Rule Sets. | Read existing `ruleSetId`; no rule mutation. |
| Work time | Show scheduling summary placeholders: shifts, assignments, rotation, and comprehensive hours live elsewhere. | Read-only summary or link only in V1. |
| Punch method | Show global setting summary if already available. Otherwise show "Not configured in attendance group V1." | No new group-specific punch schema. |
| Advanced controls | Owner, sub-owner, photo, face, hardware, auto-match, field work, overtime, rest-day, makeup. | Deferred; display only as unavailable or handled in other modules. |

### 5.4 Save Model

The detail pane should use a single visible save action for group basic info. Member changes can remain immediate actions because the current backend contract is already per-add/per-remove.

Required behavior:

- Dirty basic info enables Save and Cancel.
- Cancel restores the selected group values.
- Save uses existing POST for new group and PUT for existing group.
- Create success selects the new group and loads its member section.
- Conflict and validation errors stay inline near the detail pane.

### 5.5 Copy Rules

Use operator language, not database language:

- Prefer "Attendance group", "People", "Rule policy", "Work time", "Punch method".
- Avoid exposing raw "rule_set_id" or "attendance_group_members".
- Do not label a group as fixed schedule, shift schedule, or free schedule unless the UI has a real existing data source for that status.
- For unsupported reference-only sections, use "Not available in group settings yet" or "Configured in another attendance module" instead of a disabled fake form.

## 6. Proposed Implementation Slices

### Slice A: Frontend UX Reshape, Existing Contracts Only

Goal: make the current group/member admin flow usable as a list-plus-detail surface.

Allowed:

- Frontend component and composable changes.
- Existing group CRUD and member CRUD calls.
- Tests in `AttendanceRulesAndGroupsSection.spec.ts`, `useAttendanceAdminRulesAndGroups.spec.ts`, or `attendance-admin-regressions.spec.ts`.
- Navigation compatibility from both existing section IDs.

Not allowed:

- Backend route/schema changes.
- New group fields.
- New member enrichment endpoint.
- Schedule, punch, photo, face, owner, or permissions work.

Implementation recommendation: converge on one production surface. Either wire `AttendanceRulesAndGroupsSection.vue` into `AttendanceView.vue`, or port the list-detail structure into the existing inline production section. Do not keep two divergent implementations.

### Slice B: Member Readability

Goal: reduce the "paste user IDs" feeling after Slice A lands.

Allowed:

- Picker-first flow.
- Selected-user chips before append.
- Duplicate prevention in UI before calling POST.
- Better empty states and member-count display if derived from existing responses.

Requires separate review if it needs display-name enrichment beyond existing data.

### Slice C: Read-Only Section Summaries

Goal: make the group detail feel complete without pretending to own every capability.

Allowed:

- Read-only status cards that link to Rule Sets, Shifts, Assignments, Advanced Scheduling, Settings, and Comprehensive Hours.
- No new writes.

Deferred:

- Group-specific punch method configuration.
- Owner/sub-owner permissions.
- Photo/face/hardware enrollment.
- Auto-match schedule configuration.

## 7. Test Matrix

| ID | Requirement | Test target |
| --- | --- | --- |
| UX1 | Create group from the detail pane, then select the created group. | Frontend component test with mocked POST/list reload. |
| UX2 | Edit an existing group; Cancel restores original values; Save calls PUT once. | Frontend component/composable test. |
| UX3 | Conflict or validation error is shown inline and does not clear unsaved input. | Frontend component test. |
| UX4 | Member picker appends to the add list; duplicate selection is ignored or clearly marked. | Frontend component test. |
| UX5 | Add/remove member uses existing endpoints and refreshes the selected group members. | Existing composable or component test. |
| UX6 | Admin rail Organization entry still reaches the group surface; legacy group-members anchor remains non-broken. | `attendance-admin-regressions.spec.ts`. |
| UX7 | Unsupported sections do not expose active fake controls. | Frontend test or snapshot text assertion. |
| UX8 | Narrow viewport keeps list/detail and sticky actions non-overlapping. | Frontend regression test plus manual screenshot before merge if runtime UI changes. |
| UX9 | No backend route, migration, or schema diff in Slice A. | Reviewer diff check. |

## 8. Open Questions

These are intentionally not answered by this design lock:

1. Should attendance groups have owner/sub-owner permissions?
2. Should punch methods ever be group-specific, or stay global/workspace-level?
3. Should reference-style work-time type labels be computed from rule sets, shifts, or explicit group settings?
4. Should member display names require a read-only user-enrichment endpoint?
5. Should mobile admin editing be supported, or is desktop admin the only target for V1?

Each question is a separate product/API decision.

## 9. Acceptance For This Design

This document is complete when:

- It records the current MetaSheet contracts before proposing UI changes.
- It locks the first runtime slice to frontend-only UX reshape using existing APIs.
- It makes unsupported reference-only features explicit deferred items.
- It provides a test matrix for the runtime slice.
- It does not modify runtime code, tests, schema, migrations, or operational scripts.
