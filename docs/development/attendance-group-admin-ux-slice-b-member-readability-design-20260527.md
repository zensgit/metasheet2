# Attendance Group Admin UX Slice B Member Readability Design

Date: 2026-05-27
Branch: `codex/attendance-group-admin-slice-b-design-20260527`
Status: design lock only

## 1. Purpose

This document locks the next narrow attendance-group admin UX slice after Slice A (`#1952`) reshaped the production group editor into a list-detail surface.

Slice B means **member readability**. It reduces the "paste user IDs" feeling inside the existing People panel without changing backend contracts, group schema, scheduling semantics, or punch-method configuration.

This document does not authorize runtime implementation. A future Slice B implementation still requires a separate explicit opt-in.

## 2. Lineage

| Link | State | Relevance |
| --- | --- | --- |
| `docs/development/attendance-group-admin-ux-parity-design-20260527.md` | Merged design lock | Defines Slice B as picker-first member readability, duplicate prevention, better empty states, and count display when derived from existing responses. |
| `#1952` | Merged runtime Slice A | Production `AttendanceView.vue` now has one list-detail attendance group manager and a People section inside selected group detail. |
| `#1954` | Open follow-up issue | Tracks the stale extracted `AttendanceRulesAndGroupsSection.vue` variant. It must be reconciled before Slice C or any reused extracted component path. |

## 3. Current Production Baseline

All code citations were verified on `origin/main` at `89360ba6f`.

| Area | Current state | Evidence |
| --- | --- | --- |
| Production group manager | Attendance groups render as one list-detail manager with `New group`, `Reload groups`, a group list, and selected detail pane. | `apps/web/src/views/AttendanceView.vue:2950`, `apps/web/src/views/AttendanceView.vue:2963`, `apps/web/src/views/AttendanceView.vue:2973`, `apps/web/src/views/AttendanceView.vue:3000` |
| Basic info | The detail pane edits name, code, timezone, rule policy, and description through the existing group API. | `apps/web/src/views/AttendanceView.vue:3022`, `apps/web/src/views/AttendanceView.vue:3028`, `apps/web/src/views/AttendanceView.vue:3063` |
| People panel | The selected group detail already contains a user picker, bulk user ID input, append action, add action, and member table. | `apps/web/src/views/AttendanceView.vue:3078`, `apps/web/src/views/AttendanceView.vue:3095`, `apps/web/src/views/AttendanceView.vue:3104`, `apps/web/src/views/AttendanceView.vue:3115`, `apps/web/src/views/AttendanceView.vue:3134` |
| Member list shape | The current member table shows only `userId`, joined time, and remove action. | `apps/web/src/views/AttendanceView.vue:3135`, `apps/web/src/views/AttendanceView.vue:3144` |
| Read-only summaries | Rule policy, Work time, and Punch method are summary cards only; schedule and punch method mutations are deferred. | `apps/web/src/views/AttendanceView.vue:3164`, `apps/web/src/views/AttendanceView.vue:3171`, `apps/web/src/views/AttendanceView.vue:3176` |
| Legacy anchor | The old Group members anchor redirects operators back to Attendance groups. | `apps/web/src/views/AttendanceView.vue:3185`, `apps/web/src/views/AttendanceView.vue:3196` |
| Group API shape | Attendance groups expose only the existing persisted shape: `id`, `orgId`, `name`, `code`, `timezone`, `ruleSetId`, `description`, timestamps. | `plugins/plugin-attendance/index.cjs:7275` |
| Member API shape | Member GET returns paginated `items`, `total`, `page`, and `pageSize`; POST accepts `userId` / `userIds` and deduplicates with `ON CONFLICT DO NOTHING`. | `plugins/plugin-attendance/index.cjs:25483`, `plugins/plugin-attendance/index.cjs:25528`, `plugins/plugin-attendance/index.cjs:25563` |
| Existing user search | A read-only attendance admin user search route is already used by provisioning; Slice B may reuse the existing picker component, but must not invent a member-enrichment endpoint. | `apps/web/src/views/attendance/useAttendanceAdminProvisioning.ts:288` |

## 4. Hard Boundaries

Slice B implementation must stay inside these boundaries:

1. No backend route, schema, migration, permission, or API contract changes.
2. No attendance fact writes.
3. No new attendance-group persisted fields.
4. No member display-name enrichment endpoint. If existing search results can label pending chips, those labels are UI-only and must not be treated as persisted member metadata.
5. No schedule calculation, fixed-schedule modeling, weekly schedule matrix, shift assignment, rotation assignment, or comprehensive-hours change.
6. No group-specific punch method configuration, Wi-Fi, location, hardware, photo, face, owner, sub-owner, delegated permission, export, copy, or import behavior.
7. No `attendance_schedule_groups` semantic reuse.
8. Do not reconcile or reuse the stale extracted `AttendanceRulesAndGroupsSection.vue` in this slice; that is tracked by `#1954` and must be resolved before Slice C.

Any item above requires a separate design and explicit opt-in.

## 5. Slice B UX Contract

### 5.1 Pending Member Chips

The People panel should turn the current bulk text box into a visible pending-add list:

- Selecting a user from the existing picker appends a pending chip.
- Manually typed IDs can still be pasted into the bulk input.
- The UI should parse comma, whitespace, and newline separated values into the same pending set before submit.
- Pending chips show the stable user ID and, only when already available from the existing picker result, an optional display label.
- Removing a pending chip should not call the backend.

The source of truth remains the user ID list sent to the existing POST route.

### 5.2 Duplicate Prevention

The UI should prevent obvious duplicates before calling POST:

- Do not add the same pending ID twice.
- Do not send a pending ID that already exists in the loaded member list.
- Preserve backend idempotency (`ON CONFLICT DO NOTHING`) as the final safety net.
- Show a small inline note such as "Already in this group" instead of silently doing nothing when the operator selects an existing member.

This is UX polish only; it must not weaken the backend dedupe behavior.

### 5.3 Member Count And Empty States

The People header may show a count only from data already returned by the member list route:

- Prefer `payload.total` when present.
- Fall back to `attendanceGroupMembers.length` only when total is absent.
- Do not add a group list aggregate count to the groups endpoint.
- If no group is saved yet, keep the existing "Save the group before adding people" empty state.
- If a saved group has no members, use copy that invites adding people rather than implying configuration is broken.

### 5.4 Member Table Readability

Without a new enrichment endpoint, the member table can improve scanability but must stay honest:

- Keep `User ID` as the durable identifier.
- Group row actions should stay narrow: remove only.
- Optional labels from a just-used picker may be shown only for current-session pending chips, not as persisted member row facts.
- Do not show department, role, mobile, email, or avatar unless those values are already returned by the existing member API or a separately approved enrichment contract.

### 5.5 Legacy Anchor

The legacy `Group members` admin anchor must remain non-broken:

- It should continue to route operators back to the Attendance groups manager.
- It should not reintroduce a second standalone member-management table.
- Tests should keep the redirect/callout locked.

## 6. Proposed Runtime Slice Shape

A future Slice B runtime PR should be one frontend-only PR:

| Change | Allowed implementation |
| --- | --- |
| Pending chips | Add a local pending-member collection to `AttendanceView.vue` People panel state. |
| Picker append | Reuse the existing `AttendanceUserPickerField`; append selected ID to pending chips instead of only appending raw text. |
| Manual parse | Normalize comma / whitespace / newline separated IDs into pending chips before submit. |
| Duplicate UX | Compare pending IDs against pending set and loaded `attendanceGroupMembers`; show inline duplicate copy. |
| Submit | POST only unique pending IDs to `/api/attendance/groups/:id/members`; refresh members after success. |
| Count display | Use member GET `total` when already loaded; no group-list aggregate API change. |
| Tests | Update `attendance-admin-anchor-nav.spec.ts` and `attendance-admin-regressions.spec.ts` around the production `AttendanceView.vue` surface. |

Do not touch backend, migrations, contracts, `plugins/plugin-attendance/index.cjs`, or extracted component implementation in the Slice B runtime PR.

## 7. Test Matrix

| ID | Requirement | Test target |
| --- | --- | --- |
| B1 | Picker selection creates a pending chip without calling POST. | `attendance-admin-anchor-nav.spec.ts` or `attendance-admin-regressions.spec.ts`. |
| B2 | Removing a pending chip removes it from the submit payload without backend calls. | Frontend test. |
| B3 | Manual paste parses comma, space, and newline separated IDs into unique pending IDs. | Frontend helper/component test. |
| B4 | Existing loaded member cannot be added again; UI shows duplicate copy and POST omits it. | Frontend test with mocked member list. |
| B5 | Submit sends only unique pending IDs through the existing POST route and refreshes members after success. | Frontend test with mocked POST and GET. |
| B6 | People header count is derived from existing member GET data; no backend diff is present. | Frontend assertion plus reviewer diff check. |
| B7 | Legacy Group members anchor still redirects to Attendance groups and does not revive the old standalone table. | Existing admin-regression test. |
| B8 | Unsupported schedule/punch controls remain summary-only; no fake controls are introduced. | Text/control absence assertion. |
| B9 | Slice B PR has no backend route, schema, migration, permission, or contract diff. | Reviewer diff check. |

## 8. Explicitly Deferred

These are not part of Slice B:

- Fixed-schedule type modeling.
- Weekly schedule matrix.
- Group-specific punch method configuration.
- Location / Wi-Fi / hardware / photo / face verification.
- Export/copy of group settings.
- Member display-name enrichment beyond data already in the current UI/session.
- Owner/sub-owner permissions or delegated admin scope.
- Reconciliation of `AttendanceRulesAndGroupsSection.vue`; see `#1954`.

## 9. Acceptance For This Design

This design lock is complete when:

- It constrains Slice B to member readability and existing APIs.
- It names the current production anchors after Slice A.
- It keeps larger attendance-detail features behind separate opt-ins.
- It records the tests a future runtime PR must satisfy.
- It adds no runtime code, test code, schema, migrations, operational scripts, or production writes.
