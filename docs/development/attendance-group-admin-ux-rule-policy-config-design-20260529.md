# Attendance Group Rule-Policy Configuration Design

Date: 2026-05-29
Branch: `codex/attendance-rule-policy-design-1924-20260529`
Status: design lock only

## 1. Purpose

The attendance group detail now has a list/detail admin surface, owner/sub-owner roster, scoped owner member management, Work time and Punch method drawers, and a read-only Rule policy drawer. The remaining #1924 gap is not another summary: it is whether operators can edit a rule policy from inside a specific attendance group and have the result mean what the UI says.

This document locks that future path. It does not add runtime code, routes, schema, migrations, permissions, OpenAPI, tests, or production writes. A later runtime PR must opt in explicitly.

The main safety concern is shared rule mutation. Today an attendance group links to `attendance_rule_sets` through `attendance_groups.rule_set_id`. Editing that linked rule set from a group detail would be dangerous if the rule set is shared by other groups, imports, or previews.

## 2. Current Baseline

Verified on `origin/main` at `efcc9f94a`.

| Area | Current state | Evidence |
| --- | --- | --- |
| Group rule link | `attendance_groups` stores `rule_set_id`; create/update accepts `ruleSetId`. | `plugins/plugin-attendance/index.cjs:26288`, `:26325`, `:26420` |
| Rule set CRUD | `/api/attendance/rule-sets` is org-admin CRUD and stores reusable rule configs in `attendance_rule_sets`. | `plugins/plugin-attendance/index.cjs:20997`, `:21300`, `:21378`, `:21473` |
| Rule-set preview | `/api/attendance/rule-sets/preview` previews a rule set config before saving. | `plugins/plugin-attendance/index.cjs:21505` |
| Group effective-calendar mode | `resolveEffectiveCalendar(... groupId ...)` loads the group's `rule_set_id` and applies that rule as the group-mode base profile. | `plugins/plugin-attendance/index.cjs:11896`, `:12052`, `:12054` |
| User calc-chain boundary | Existing follow-up documentation explicitly kept userId punch/import/payroll calc-chain unchanged when group rule-set preview landed. | `docs/development/attendance-effective-calendar-group-ruleset-development-20260521.md` |
| Frontend group detail | Basic info lets admins choose a `ruleSetId`; the Rule policy drawer summarizes the selected rule set and states that group-owned rule overrides do not exist yet. | `apps/web/src/views/AttendanceView.vue:3209`, `:3558`, `:3589` |
| Owner delegation | Owners/sub-owners can manage group members only; rule sets and group basics remain `attendance:admin` guarded. | `plugins/plugin-attendance/index.cjs:15121`, `:15135`, `:26485`, `:26620` |

## 3. Design Decision

Group-owned rule editing must be **copy-on-write**, never "edit the currently linked shared rule set in place."

The group detail can become an edit surface only after the runtime model can answer three questions:

1. Which rule set is owned exclusively by this attendance group?
2. Which surfaces will use it after save: group preview only, or the userId calc-chain used by punch/import/payroll?
3. What happens when a user belongs to multiple attendance groups with different owned rules?

Until those are implemented, the current read-only drawer is the honest V1.

## 4. Ownership Model

Recommended future model:

- Keep `attendance_groups.rule_set_id` as the effective rule pointer.
- Add ownership metadata to rule sets or a small relation table so the system can tell shared org rule sets from group-owned rule sets.
- Treat a rule set as group-owned only when its ownership metadata points to the same `attendance_groups.id`.

Recommended shape:

| Field | Meaning |
| --- | --- |
| `owner_kind` | `org` or `attendance_group`. Existing rows migrate to `org`. |
| `owner_ref_id` | Nullable; group id when `owner_kind = attendance_group`. |
| `source_rule_set_id` | Optional provenance when cloned from an org/shared rule set. |

A relation table is acceptable if the implementation prefers not to alter `attendance_rule_sets`, but it must still support a unique group-owned rule per `(org_id, group_id)` and must not overload `attendance_group_members` or `attendance_group_managers`.

## 5. Copy-On-Write Contract

When an admin edits rules from a group detail:

| Current group state | Runtime behavior |
| --- | --- |
| No linked rule set | Clone the org default/template config into a new group-owned rule set, link the group to it, then edit. |
| Linked rule set is shared/org-owned | Clone it into a group-owned rule set in the same transaction, link the group to the clone, then edit the clone. |
| Linked rule set is already owned by this group | Update that rule set. |
| Linked rule set is owned by another group | Reject as invalid data; never mutate it. |

The save path must be transactional: create/clone/update the rule set and update the group link together, or write nothing.

The UI copy must say "Create group-owned copy" or "Edit this group's rule copy" rather than implying that shared rules are edited in place.

## 6. Effective Scope

There are two possible runtime tracks. They must not be blurred.

### Track R1: Group-preview rule editing

Allowed first runtime track:

- group detail can own and edit a copied rule set;
- `GET/POST /api/attendance/effective-calendar` in `groupId` mode uses it, as it already does;
- imports, punch writeback, payroll/materialized facts, and `userId` effective-calendar remain unchanged;
- the UI must label this as "group preview / configuration" and must not claim punch/payroll enforcement.

This is smaller and safer, but it is not full rule enforcement.

### Track R2: User calc-chain enforcement

Full enforcement requires a separate opt-in after R1:

- resolve the user's effective attendance group for a date;
- define behavior for users in zero groups or multiple groups;
- apply that group's owned rule set to `userId` effective-calendar, import evaluation, and payroll/materialized calculations if product wants real downstream effect;
- keep punch-method policy separate from rule policy;
- add enough provenance/diagnostics so operators can understand which group/rule drove a derived result.

R2 is not a UI slice. It is a calculation-chain product decision with integration coverage.

## 7. Permissions

Initial runtime must stay admin-only:

- `attendance:admin` can create/clone/edit group-owned rule sets from the group detail.
- Owners/sub-owners from `attendance_group_managers` do **not** get rule-policy editing automatically.
- Delegated owner rule editing requires a separate permission design after the admin-only path is proven.

This keeps #2101's scoped owner member-management guard from accidentally becoming a broad group-admin role.

## 8. Hard Boundaries

The first runtime PR must not:

1. mutate an org/shared rule set from the group detail;
2. change punch-method policy, IP/geofence/min-interval enforcement, or `attendance_events` / `attendance_records`;
3. change import/payroll/userId calc-chain unless the PR is explicitly the R2 track with integration coverage;
4. grant owners/sub-owners rule editing;
5. create disabled fake controls for unsupported rule dimensions;
6. reuse `attendance_schedule_groups`;
7. write comprehensive-hours snapshots or reporting facts;
8. promise mobile rule editing.

## 9. Proposed Runtime Slices

| Slice | Goal | Scope |
| --- | --- | --- |
| RP-A | This design lock | Docs-only. |
| RP-B | Admin-only copy-on-write backend | Ownership metadata + transactional clone/update/link endpoints. No user calc-chain change. |
| RP-C | Group-detail rule editor | Frontend editor uses RP-B; preview before save; labels effect as group-preview/configuration. |
| RP-D | User calc-chain cutover | Separate product decision for member-to-group resolution, multi-group ambiguity, imports/payroll/effective-calendar behavior. |
| RP-E | Delegated owner editing | Separate permission design, after RP-B/RP-C are stable. |

Do not combine RP-B and RP-D. The first proves storage/ownership safety; the second changes business semantics.

## 10. Test Matrix For Runtime

| ID | Requirement | Test target |
| --- | --- | --- |
| RP1 | Editing a shared rule from a group clones it and links the group to the clone in one transaction. | Backend route/integration test. |
| RP2 | Editing an already group-owned rule updates only that group's owned rule. | Backend test. |
| RP3 | Rule set owned by another group is rejected. | Backend test. |
| RP4 | A failed clone/update leaves both `attendance_rule_sets` and `attendance_groups.rule_set_id` unchanged. | Transaction test. |
| RP5 | Group detail UI does not issue direct PUT to a shared rule set. | Frontend mocked API test. |
| RP6 | R1 UI copy does not claim punch/import/payroll enforcement. | Frontend text assertion. |
| RP7 | `groupId` effective-calendar preview uses the group-owned rule. | Backend effective-calendar test. |
| RP8 | `userId` calc-chain remains unchanged in R1. | Backend regression test. |
| RP9 | R2, if implemented later, defines zero-group and multi-group behavior. | Integration tests with zero/one/multiple group membership. |
| RP10 | Owners/sub-owners cannot edit rule policy unless a later delegated rule-editing slice explicitly grants it. | Permission test. |

## 11. Acceptance For This Design

This design is complete when it records:

- the current `attendance_groups.rule_set_id` link and read-only rule drawer baseline;
- why shared rule-set in-place mutation is forbidden;
- the recommended ownership/copy-on-write model;
- the difference between R1 group-preview configuration and R2 user calc-chain enforcement;
- the admin-only permission boundary;
- the runtime slice order and tests.
