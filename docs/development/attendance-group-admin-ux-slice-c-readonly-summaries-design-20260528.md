# Attendance Group Admin UX Slice C Read-Only Summaries Design

Date: 2026-05-28
Branch: `codex/attendance-group-slice-c-design-20260528`
Status: design lock only

## 1. Purpose

Slice C makes the selected attendance group detail feel like a complete operator checklist without pretending that every referenced capability is editable inside attendance-group settings.

The runtime slice after this design should add or refine **read-only summary cards** inside the existing production group detail. It must not add backend contracts, group-specific punch settings, schedule modeling, member enrichment, owner/sub-owner permissions, export/copy, or any fake controls.

This document does not authorize runtime implementation. A future Slice C implementation still requires a separate explicit opt-in.

## 2. Lineage

| Link | State | Relevance |
| --- | --- | --- |
| `docs/development/attendance-group-admin-ux-parity-design-20260527.md` | merged design lock | Defines Slice C as read-only section summaries and warns not to pretend unsupported capabilities are editable. |
| `#1952` | merged Slice A runtime | Ports the group manager into the production `AttendanceView.vue` list-detail surface. |
| `docs/development/attendance-group-admin-ux-slice-b-member-readability-design-20260527.md` | merged design lock | Constrains Slice B to member readability and keeps Slice C separate. |
| `#1957` | merged Slice B runtime | Adds pending member chips, duplicate handling, and count copy in the People panel. |
| `#1954` / `#1961` | closed / merged | Retires the stale extracted `AttendanceRulesAndGroupsSection.vue`; Slice C now has one production UI path to extend. |

## 3. Current Production Baseline

All code citations were verified on `origin/main` at `86177432f`.

| Area | Current state | Evidence |
| --- | --- | --- |
| Production group manager | Attendance groups render inside `AttendanceView.vue` as one list-detail manager with a list pane and selected detail pane. | `apps/web/src/views/AttendanceView.vue:2949`, `apps/web/src/views/AttendanceView.vue:2972`, `apps/web/src/views/AttendanceView.vue:3000` |
| Basic info write path | The Basic info panel owns group create/update and is the only group-basic write surface in the detail pane. | `apps/web/src/views/AttendanceView.vue:3022`, `apps/web/src/views/AttendanceView.vue:3063`, `apps/web/src/views/AttendanceView.vue:3070` |
| People write path | The People panel owns member reload, pending chips, duplicate notices, add, remove, and the member table. | `apps/web/src/views/AttendanceView.vue:3078`, `apps/web/src/views/AttendanceView.vue:3095`, `apps/web/src/views/AttendanceView.vue:3118`, `apps/web/src/views/AttendanceView.vue:3141`, `apps/web/src/views/AttendanceView.vue:3160`, `apps/web/src/views/AttendanceView.vue:3177` |
| Current summaries | Existing group detail has three summary cards: Rule policy, Work time, and Punch method. They are copy-only and do not add schedule/punch mutations. | `apps/web/src/views/AttendanceView.vue:3197`, `apps/web/src/views/AttendanceView.vue:3199`, `apps/web/src/views/AttendanceView.vue:3203`, `apps/web/src/views/AttendanceView.vue:3208` |
| Legacy member anchor | The old Group members section redirects operators back to Attendance groups and does not revive a second member table. | `apps/web/src/views/AttendanceView.vue:3218`, `apps/web/src/views/AttendanceView.vue:3225`, `apps/web/src/views/AttendanceView.vue:3229` |
| Admin rail destinations | Existing admin destinations already include Settings, Rule Sets, Advanced scheduling, Comprehensive hours, Rotation Rules, Rotation Assignments, Shifts, Assignments, Holidays, Attendance groups, and Group members. | `apps/web/src/views/attendance/useAttendanceAdminRail.ts:12`, `apps/web/src/views/attendance/useAttendanceAdminRail.ts:160`, `apps/web/src/views/attendance/useAttendanceAdminRail.ts:169`, `apps/web/src/views/attendance/useAttendanceAdminRail.ts:179`, `apps/web/src/views/attendance/useAttendanceAdminRail.ts:183` |
| Admin rail grouping | Existing nav groups already separate Scheduling, Organization, Policies, and Data & Payroll. Slice C should link to those destinations rather than create new group-owned editors. | `apps/web/src/views/attendance/useAttendanceAdminRail.ts:188`, `apps/web/src/views/attendance/useAttendanceAdminRail.ts:199`, `apps/web/src/views/attendance/useAttendanceAdminRail.ts:212`, `apps/web/src/views/attendance/useAttendanceAdminRail.ts:220`, `apps/web/src/views/attendance/useAttendanceAdminRail.ts:233` |
| Existing backend contracts | Group CRUD and member CRUD already exist; Slice C does not need new backend routes. | `plugins/plugin-attendance/index.cjs:25216`, `plugins/plugin-attendance/index.cjs:25271`, `plugins/plugin-attendance/index.cjs:25303`, `plugins/plugin-attendance/index.cjs:25366`, `plugins/plugin-attendance/index.cjs:25454`, `plugins/plugin-attendance/index.cjs:25485`, `plugins/plugin-attendance/index.cjs:25530`, `plugins/plugin-attendance/index.cjs:25588` |
| Existing tests | Production tests already cover Attendance groups navigation, Group members redirect, and current summary-card presence. | `apps/web/tests/attendance-admin-anchor-nav.spec.ts:692`, `apps/web/tests/attendance-admin-anchor-nav.spec.ts:707`, `apps/web/tests/attendance-admin-anchor-nav.spec.ts:711`, `apps/web/tests/attendance-admin-regressions.spec.ts:593`, `apps/web/tests/attendance-admin-regressions.spec.ts:617`, `apps/web/tests/attendance-admin-regressions.spec.ts:632` |

## 4. Hard Boundaries

Slice C implementation must stay inside these boundaries:

1. No backend route, schema, migration, permission, OpenAPI, or plugin contract changes.
2. No attendance fact writes.
3. No new persisted attendance-group fields.
4. No member display-name enrichment endpoint or persisted member labels.
5. No fixed-schedule modeling, weekly schedule matrix editing, shift assignment mutation, rotation assignment mutation, or schedule-calculation changes.
6. No group-specific punch method configuration, Wi-Fi, location, hardware, photo, face, owner, sub-owner, delegated permission, export, copy, or import behavior.
7. No `attendance_schedule_groups` semantic reuse. Attendance groups remain policy/membership groups; schedule groups remain scheduling-workbench groups.
8. No reporting, analytics snapshot, or external integration work.
9. No fake controls. If a card has no real existing data source or approved write path, it must be explicit read-only copy or a navigation action to an existing section.

Any item above requires a separate design and explicit opt-in.

## 5. Slice C UX Contract

### 5.1 Ownership Model

The selected attendance group detail should have exactly two write-capable areas:

- **Basic info**: group name, code, timezone, rule policy selector, description, save/cancel/delete through the existing group CRUD.
- **People**: staged member IDs, member add/remove, member reload through the existing member CRUD.

All other cards in Slice C are summaries or navigation affordances.

### 5.2 Summary Card Set

Slice C may refine the current `data-attendance-group-summaries` grid into these cards:

| Card | Runtime content | Allowed action | Not allowed |
| --- | --- | --- | --- |
| Rule policy | Show linked rule-set label or default-rule fallback. | Navigate to Rule Sets. | Mutate rule-set contents from the group card. |
| Work time | Explain that shifts and assignments own work-time execution. | Navigate to Shifts and Assignments. | Claim fixed/shift/free schedule type unless backed by an existing source. |
| Scheduling coverage | Explain advanced scheduling / rotations live in scheduling modules. | Navigate to Advanced scheduling, Rotation Rules, or Rotation Assignments. | Create schedule-group, shift, rotation, or assignment rows. |
| Comprehensive hours | Explain comprehensive-hours review/reporting lives in its own admin surface. | Navigate to Comprehensive hours. | Run preview, save cap policy, or write reporting snapshots from the group card. |
| Punch method | Show workspace-level punch settings only; if no trustworthy group-level data exists, say group-specific punch method is not configured in group settings V1. | Navigate to Settings. | Add group-specific Wi-Fi/location/device/photo/face fields. |
| Advanced controls | Explicitly list owner/sub-owner, export/copy, hardware, photo/face, field work, rest-day punch, makeup, and auto-match as deferred or configured elsewhere. | None, or navigation only when an existing section owns it. | Render disabled form controls that look like editable settings. |

### 5.3 Navigation Affordances

Navigation buttons or links are allowed only when they call existing frontend section navigation, such as `selectAdminSection(...)`, and only target existing admin section IDs.

Allowed examples:

- `Open Rule Sets`
- `Open Shifts`
- `Open Assignments`
- `Open Advanced scheduling`
- `Open Comprehensive hours`
- `Open Settings`

These actions must not send API writes. They are location changes inside the admin console.

### 5.4 Copy Rules

Use operator language:

- Prefer "Configured in Shifts and Assignments" over "missing `shift_id`".
- Prefer "Workspace punch settings" over "global punch schema".
- Prefer "Not configured in attendance group V1" over disabled toggles.
- Prefer "Open ..." for navigation, not "Set ..." unless the target card truly mutates data.

Do not imply a capability exists just because the reference workflow names it.

### 5.5 Empty And Unsaved States

When no group is selected or the group is not saved yet:

- Basic info remains editable for create.
- People keeps the existing "Save the group before adding people" empty state.
- Summary cards may show "Choose or save a group first" and still explain where the capability is configured.
- Navigation links may remain available if they are independent of the selected group, but must not pass fake group context.

### 5.6 Legacy Anchor

The legacy `Group members` admin anchor remains a redirect/callout to Attendance groups. Slice C must not reintroduce a standalone Group members editor.

## 6. Proposed Runtime Slice Shape

A future Slice C runtime PR should be one frontend-only PR:

| Change | Allowed implementation |
| --- | --- |
| Summary card expansion | Update the existing `data-attendance-group-summaries` grid in `AttendanceView.vue`. |
| Navigation actions | Reuse existing admin section IDs and `selectAdminSection(...)`. |
| Copy states | Add clear read-only copy for unsupported group-specific punch/schedule/advanced controls. |
| Tests | Extend `attendance-admin-anchor-nav.spec.ts` and `attendance-admin-regressions.spec.ts` around the production `AttendanceView.vue` surface. |
| Verification | Confirm no backend/plugin/schema/migration/contract files changed. |

Do not touch `plugins/plugin-attendance/index.cjs`, migrations, OpenAPI contracts, extracted component paths, external integration modules, or unrelated admin sections.

## 7. Test Matrix

| ID | Requirement | Test target |
| --- | --- | --- |
| C1 | Summary grid includes Rule policy, Work time, Scheduling coverage, Comprehensive hours, Punch method, and Advanced controls. | `attendance-admin-regressions.spec.ts` or `attendance-admin-anchor-nav.spec.ts`. |
| C2 | Each summary card is read-only: no inputs/selects/toggles/save buttons inside the summary grid. | Frontend DOM assertion scoped to `data-attendance-group-summaries`. |
| C3 | Navigation actions use existing admin anchors and move to the expected section without API writes. | Frontend test with mocked `apiFetch` call count / section anchor assertion. |
| C4 | Rule policy card shows linked rule-set label or default fallback without mutating rule sets. | Frontend test with mocked `ruleSets`. |
| C5 | Work time / Scheduling card copy does not claim fixed/shift/free group schedule type without a real source. | Text absence/presence assertion. |
| C6 | Punch method card does not expose group-specific Wi-Fi/location/device/photo/face controls. | Scoped control absence assertion. |
| C7 | Unsaved group state still shows safe summary copy and does not pass fake group context. | Frontend create-state test. |
| C8 | Legacy Group members anchor continues to redirect/call out to Attendance groups. | Existing admin-regression test extended if needed. |
| C9 | Runtime PR has no backend route, schema, migration, permission, OpenAPI, plugin, or integration diff. | Reviewer diff check. |
| C10 | `AttendanceRulesAndGroupsSection.vue` remains retired; no extracted-component path is reintroduced. | Source grep / reviewer diff check. |

## 8. Explicitly Deferred

These are not part of Slice C:

- fixed-schedule type modeling;
- weekly schedule matrix;
- group-specific punch method configuration;
- location / Wi-Fi / hardware / photo / face verification;
- export/copy of group settings;
- member display-name enrichment beyond current session UI state;
- owner/sub-owner permissions or delegated admin scope;
- schedule-group to attendance-group semantic merge;
- reporting/PR6 changes;
- backend/schema/migration/route work.

## 9. Acceptance For This Design

This design lock is complete when:

- it names the current post-#1961 single production surface;
- it constrains Slice C to read-only summaries and navigation;
- it keeps Basic info and People as the only write-capable group-detail areas;
- it explicitly rejects fake controls for unsupported capabilities;
- it records the tests a future runtime PR must satisfy;
- it adds no runtime code, test code, schema, migrations, operational scripts, or production writes.
