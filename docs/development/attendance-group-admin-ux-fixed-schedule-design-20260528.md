# Attendance Group Admin UX Fixed Schedule Design

Date: 2026-05-28
Branch: `codex/attendance-group-schedule-design-20260528`
Status: design lock only

## 1. Purpose

The attendance-group admin UX is now a single production surface with Basic info and People as the only write-capable areas, plus read-only summary cards for adjacent capabilities. The next useful group-detail capability is a real fixed-schedule path: choose a saved attendance group, choose one existing shift, choose an explicit date window, preview the affected members and conflicts, then create the corresponding per-user shift assignments.

This document locks that future path without starting implementation. It does not add runtime code, backend routes, migrations, schema, permissions, UI controls, production writes, or staging/prod probes.

## 2. Lineage

| Link | State | Relevance |
| --- | --- | --- |
| `docs/development/attendance-group-admin-ux-parity-design-20260527.md` | merged design lock | Defines the selected attendance group as the operator's primary object and forbids `attendance_schedule_groups` semantic reuse. |
| `#1952` | merged Slice A runtime | Converged group CRUD and member CRUD into the production `AttendanceView.vue` list-detail surface. |
| `docs/development/attendance-group-admin-ux-slice-b-member-readability-design-20260527.md` / `#1957` | merged design + runtime | Makes People usable while keeping `userId` as the only member identity/payload. |
| `#1954` / `#1961` | closed / merged | Retires the stale extracted component; there is one production group surface to extend. |
| `docs/development/attendance-group-admin-ux-slice-c-readonly-summaries-design-20260528.md` / `#1965` | merged design + runtime | Adds read-only summary cards and explicitly defers fixed-schedule modeling. |
| `docs/development/attendance-group-admin-ux-member-label-enrichment-design-20260528.md` / `#1980` | merged design + runtime | Enriches loaded People labels without changing identity, payload, or backend membership semantics. |

## 3. Current Production Baseline

All code citations were verified on `origin/main` at `4a7485dce`.

| Area | Current state | Evidence |
| --- | --- | --- |
| Production group surface | Attendance groups render in `AttendanceView.vue` as one list-detail manager with Basic info, People, and summary cards. | `apps/web/src/views/AttendanceView.vue:2949`, `apps/web/src/views/AttendanceView.vue:3000`, `apps/web/src/views/AttendanceView.vue:3022`, `apps/web/src/views/AttendanceView.vue:3078`, `apps/web/src/views/AttendanceView.vue:3214` |
| Work time card today | The Work time summary says schedules are configured in Shifts and Assignments and only navigates to those existing sections. | `apps/web/src/views/AttendanceView.vue:8013`, `apps/web/src/views/AttendanceView.vue:8015`, `apps/web/src/views/AttendanceView.vue:8017` |
| Group shape | `attendance_groups` exposes identity, code, timezone, rule-set link, description, and timestamps; it has no schedule field. | `plugins/plugin-attendance/index.cjs:7275` |
| Group members | Member list is paginated and returns `items`, `total`, `page`, and `pageSize`; add/remove are existing group-member CRUD. | `plugins/plugin-attendance/index.cjs:25483`, `plugins/plugin-attendance/index.cjs:25493`, `plugins/plugin-attendance/index.cjs:25508`, `plugins/plugin-attendance/index.cjs:25528`, `plugins/plugin-attendance/index.cjs:25586` |
| Shift shape | Shifts already carry work start/end, timezone, grace/rounding, and `workingDays`; V1 does not need a separate weekly matrix to express the shift's normal weekdays. | `plugins/plugin-attendance/index.cjs:7248`, `plugins/plugin-attendance/index.cjs:7270`, `packages/core-backend/src/db/migrations/zzzz20260114120000_add_attendance_scheduling_tables.ts:10`, `packages/core-backend/src/db/migrations/zzzz20260114120000_add_attendance_scheduling_tables.ts:24` |
| Shift admin routes | Existing shift list/detail/create/update/delete routes own the shift catalog. | `plugins/plugin-attendance/index.cjs:26490`, `plugins/plugin-attendance/index.cjs:26545`, `plugins/plugin-attendance/index.cjs:26574`, `plugins/plugin-attendance/index.cjs:26640`, `plugins/plugin-attendance/index.cjs:26751` |
| Assignment shape | Shift assignment rows are per-user facts: `userId`, `shiftId`, `startDate`, `endDate`, `isActive`. | `plugins/plugin-attendance/index.cjs:7957`, `plugins/plugin-attendance/index.cjs:14481`, `packages/core-backend/src/db/migrations/zzzz20260114120000_add_attendance_scheduling_tables.ts:32`, `packages/core-backend/src/db/migrations/zzzz20260114120000_add_attendance_scheduling_tables.ts:39` |
| Assignment admin routes | Existing assignment list/create/update/delete routes already create the facts consumed by scheduling/effective-calendar logic. | `plugins/plugin-attendance/index.cjs:26825`, `plugins/plugin-attendance/index.cjs:26903`, `plugins/plugin-attendance/index.cjs:26992`, `plugins/plugin-attendance/index.cjs:27105` |
| Assignment conflict guard | Existing assignment writes use a conflict helper that checks overlapping active shift and rotation assignment rows for the same user. | `plugins/plugin-attendance/index.cjs:8617`, `plugins/plugin-attendance/index.cjs:8622`, `plugins/plugin-attendance/index.cjs:8632`, `plugins/plugin-attendance/index.cjs:8647`, `plugins/plugin-attendance/index.cjs:26940`, `plugins/plugin-attendance/index.cjs:26942` |
| Effective-calendar consumer | User effective-calendar resolution reads active `attendance_shift_assignments` by user and date; it does not read a group-level fixed-schedule field. | `plugins/plugin-attendance/index.cjs:10577`, `plugins/plugin-attendance/index.cjs:10586`, `plugins/plugin-attendance/index.cjs:10588`, `plugins/plugin-attendance/index.cjs:11046` |
| Advanced scheduling groups | `attendance_schedule_groups` and related members/scopes already exist for the advanced scheduling workbench and are separate from attendance-group settings. | `packages/core-backend/src/db/migrations/zzzz20260522100000_create_attendance_schedule_groups.ts:13`, `packages/core-backend/src/db/migrations/zzzz20260522100000_create_attendance_schedule_groups.ts:20`, `packages/core-backend/src/db/migrations/zzzz20260522100000_create_attendance_schedule_groups.ts:46`, `packages/core-backend/src/db/migrations/zzzz20260522100000_create_attendance_schedule_groups.ts:87` |

## 4. Design Decision

Fixed schedule V1 is **not** a new persistent schedule type on `attendance_groups`.

Fixed schedule V1 means:

1. The operator selects a saved attendance group.
2. The operator selects one existing shift from the shift catalog.
3. The operator enters an explicit `startDate` and `endDate`.
4. The system enumerates the group's current member user IDs.
5. The system previews the exact per-user assignment rows that would be created.
6. Only after preview passes, the system creates active `attendance_shift_assignments` rows.

The resulting `attendance_shift_assignments` rows are the only schedule facts. The effective-calendar and downstream calc paths continue to read assignments exactly as they do today.

This is intentionally narrower than a full schedule editor. It proves the group-detail workflow can drive an existing scheduling fact safely without inventing a second source of truth.

## 5. Hard Boundaries

The future runtime implementation must stay inside these boundaries unless a later design explicitly changes them:

1. No new `attendance_groups` schedule column or JSON field in this V1.
2. No new schedule fact table in this V1.
3. No migration unless a later design decides to add producer/source metadata for managed assignments.
4. No `attendance_schedule_groups` semantic reuse. Attendance groups remain membership/policy groups; schedule groups remain advanced-scheduling workbench groups.
5. No weekly schedule matrix editing.
6. No rotation assignment generation.
7. No group-specific punch method, Wi-Fi, location, hardware, photo, face, owner, sub-owner, export, copy, field-work, rest-day punch, makeup, comprehensive-hours cap, or reporting snapshot writes.
8. No implicit schedule inference from group name, group code, timezone, member labels, or prior assignments.
9. No frontend loop that posts one assignment per visible row without a complete conflict preview and all-member target resolution.
10. No writes when any target has an unresolved blocking conflict. Already-satisfied targets may be skipped, and missing targets may still be created in the same apply run.

This design document itself is docs-only and does not authorize the write path. The implementation is a separate explicit opt-in because it reopens scheduling writes.

## 6. Runtime Route Contract To Lock Later

The runtime PR should use group-scoped producer routes rather than a frontend loop over the existing single-assignment endpoint:

| Route | Verb | Behavior |
| --- | --- | --- |
| `/api/attendance/groups/:id/fixed-schedule/preview` | `POST` | Read-only. Resolve group, shift, complete member target set, date window, already-satisfied skips, and blocking conflicts. Return the would-create rows. |
| `/api/attendance/groups/:id/fixed-schedule/apply` | `POST` | Write. Re-run the same validation and conflict check inside a transaction; create rows only when no blocking conflict remains. Already-satisfied targets are skipped, not errors. |

Payload:

```json
{
  "shiftId": "uuid",
  "startDate": "YYYY-MM-DD",
  "endDate": "YYYY-MM-DD"
}
```

Response fields should include:

| Field | Meaning |
| --- | --- |
| `groupId` | Saved attendance group ID. |
| `shiftId` | Existing shift ID. |
| `window.startDate` / `window.endDate` | Echoed validated date window. |
| `target.total` | Total group members enumerated for the run. |
| `target.userIds` | User IDs targeted by the run, or a bounded sample plus total if the response would be too large. |
| `wouldCreate[]` | Candidate assignment rows in preview. |
| `created[]` | Created assignment rows in apply. |
| `skipped[]` | Per-user rows that are already satisfied by an active exact-match assignment. |
| `blockingConflicts[]` | Per-user overlap details that do not match the requested shift/window and therefore block the apply. |

Route names may be adjusted during implementation, but the preview/apply separation, group-scoped target resolution, skip-vs-conflict semantics, and fail-closed-on-blocking-conflict write policy are not optional.

## 7. Member Target Resolution

The current UI only loads the visible member page. That visible list must not be treated as the full group membership for fixed-schedule writes.

Runtime must do one of these:

1. Preferred: enumerate `attendance_group_members` server-side inside the preview/apply producer.
2. Acceptable only for a frontend-only preview: explicitly page through every member page before enabling preview/apply, and show `loaded === total`.

Apply must not run from a partial member page. This closes the known pagination gap from the People panel and prevents silently scheduling only the first page of a large group.

Member labels are not inputs. `userId` remains the only identity and assignment payload key.

## 8. Conflict And Idempotency Policy

V1 should use the existing assignment overlap semantics as the source of truth, but classify overlaps before deciding whether to block:

- active exact-match shift assignment for the same user, same `shiftId`, same `startDate`, and same normalized `endDate`: `skip` / already satisfied;
- active overlapping shift assignment for the same user with a different shift or different window: blocking conflict;
- active overlapping rotation assignment for the same user: blocking conflict;
- inactive existing assignment: not a conflict for V1 unless the runtime PR deliberately opts into handling it;
- exact rerun of the same group/shift/window: return `skipped[]` for already-satisfied members and create rows only for newly added members that are missing the assignment.

`skip + create` is allowed and is not considered partial success. It is the idempotent full application of the requested group/shift/window over the current target set. A run becomes fail-closed only when `blockingConflicts[]` is non-empty; in that case, apply writes zero rows.

Because the current `attendance_shift_assignments` schema has no producer/source marker, V1 must not promise managed-row rebuild/delete semantics. It can promise safety:

1. preview before write;
2. no writes when unresolved blocking conflicts exist;
3. no silent overwrite of manual assignments;
4. no duplicate assignment creation on rerun;
5. clear result summary for target count, skipped count, blocking conflict count, and created count.

If a future product decision needs "reapply this group schedule and replace prior generated rows", that is a separate producer-metadata design and may require a migration.

## 9. UI Contract

The group detail should keep Basic info and People as the only immediate write sections until the fixed-schedule runtime PR lands.

When fixed-schedule runtime is explicitly opted in, the UI may add a Work time panel under the selected group detail with:

- selected group name and member count;
- shift selector using existing shift catalog;
- required start/end date fields;
- preview button;
- conflict/result panel;
- apply button enabled only after a preview with zero blocking conflicts;
- link to Shifts for editing shift definitions;
- link to Assignments for inspecting created rows.

The UI must not render disabled weekly-matrix, punch-method, owner/sub-owner, export/copy, or comprehensive-hours controls as if they are partially available.

Copy should be direct:

- "Assign this shift to current group members for a date range."
- "Preview conflicts before applying."
- "Assignments are written as per-user shift assignments."
- "Members added after this run are not automatically scheduled; run again for the same window to skip already-scheduled members and create rows for new members."

## 10. Proposed Implementation Slices

| Slice | Goal | Scope |
| --- | --- | --- |
| FS-A | This design lock | Docs-only. No runtime. |
| FS-B | Read-only preview | Backend preview route plus frontend preview panel. No writes. Proves all-member target enumeration and conflict reporting. |
| FS-C | Apply path | Backend apply route plus frontend apply confirmation. Writes `attendance_shift_assignments` only after re-validating a clean preview in a transaction. |
| FS-D | Optional producer metadata | Separate design only if rebuild/delete/managed-row semantics are required. May require migration. |

Do not combine FS-B and FS-C unless the implementation stays small and the tests prove both read-only preview and write safety. Weekly matrix remains outside this chain.

## 11. Test Matrix For Future Runtime

| ID | Requirement | Test target |
| --- | --- | --- |
| FS1 | Design PR has only this documentation file and no runtime diff. | Reviewer diff check. |
| FS2 | Preview rejects unsaved/missing group, missing shift, invalid date range, empty group, and partial member enumeration. | Backend unit/integration plus frontend state test. |
| FS3 | Preview enumerates all group members, not only the first loaded UI page. | Backend test with more than one page of members. |
| FS4 | Preview payload and apply payload use `userId` only; labels never participate in identity or writes. | Frontend/backend request assertion. |
| FS5 | Preview classifies exact-match active shift assignment as `skipped[]`, and different active shift/rotation overlaps as `blockingConflicts[]`. | Backend test around the conflict helper or route-level mock DB. |
| FS6 | Apply re-runs validation in a transaction and writes zero rows when any blocking conflict is present. | Backend integration or route-level transaction test. |
| FS7 | Clean apply creates one active `attendance_shift_assignments` row per missing target member with selected `shiftId`, `startDate`, `endDate`, and `isActive=true`, while returning already-satisfied targets as skipped. | Backend integration test. |
| FS8 | Effective-calendar for a target user/date resolves the created shift assignment. | Backend route/integration test against `GET /api/attendance/effective-calendar`. |
| FS9 | Rerun of the same group/shift/window does not create duplicate rows and can schedule newly added members. | Backend test: first apply creates, second apply skips existing rows; after adding a new member, rerun creates only that member. |
| FS10 | UI apply button is disabled until a clean preview is available; failed apply keeps form values. | Frontend regression test. |
| FS11 | No `attendance_schedule_groups` read/write is introduced for this feature. | Source grep / reviewer diff check. |
| FS12 | No weekly matrix, punch-method, owner/sub-owner, export/copy, comprehensive-hours write, migration, or reporting diff is introduced. | Reviewer diff check. |

## 12. Explicitly Deferred

These remain separate opt-ins, each requiring its own design lock before runtime:

- weekly schedule matrix;
- multiple shifts per weekday;
- rotation generation from a group detail;
- automatic scheduling of future members;
- group-specific punch method;
- owner/sub-owner permissions;
- export/copy group settings;
- field work / rest-day punch / makeup rules;
- comprehensive-hours writes from the group detail;
- producer metadata and managed assignment replacement;
- semantic merge between attendance groups and schedule groups.

## 13. Acceptance For This Design

This design is complete when:

- it records the current single production surface and existing assignment fact model;
- it defines fixed schedule V1 as group + shift + explicit date window -> per-user shift assignments;
- it forbids a new group schedule fact and `attendance_schedule_groups` reuse;
- it states that implementation reopens scheduling writes and therefore needs a separate opt-in;
- it requires all-member target resolution, preview, skip-vs-conflict checks, and zero writes when blocking conflicts exist;
- it records a future test matrix that protects identity, conflicts, effective-calendar consumption, and boundary discipline;
- it adds no runtime code, tests, schema, migrations, routes, permissions, OpenAPI, ops scripts, or production writes.
