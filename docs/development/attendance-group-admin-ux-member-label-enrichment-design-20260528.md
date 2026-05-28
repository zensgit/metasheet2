# Attendance Group Admin UX Member Label Enrichment Design

Date: 2026-05-28
Branch: `codex/attendance-group-member-enrichment-design-20260528`
Status: design lock only

## 1. Purpose

The attendance-group admin UX now has one production surface: `AttendanceView.vue` owns Basic info, People, and the read-only summary cards. Slice B made People easier to operate with pending chips and duplicate handling, but saved member rows still render as raw `userId` values only.

This document locks the next narrow design: make the loaded member table more readable by showing a best-effort user label next to the durable `userId`.

This is docs-only. It does not authorize runtime implementation. A future runtime PR still requires a separate explicit opt-in.

## 2. Lineage

| Link | State | Relevance |
| --- | --- | --- |
| `docs/development/attendance-group-admin-ux-parity-design-20260527.md` | merged design lock | Introduces the list-detail attendance-group direction and defers member display-name enrichment as a separate product/API question. |
| `docs/development/attendance-group-admin-ux-slice-b-member-readability-design-20260527.md` / `#1957` | merged design + runtime | Adds picker-first staging, pending chips, duplicate UX, and count copy while keeping members as `userId` facts. |
| `#1954` / `#1961` | closed / merged | Retires the stale extracted component so there is one production group UI path. |
| `docs/development/attendance-group-admin-ux-slice-c-readonly-summaries-design-20260528.md` / `#1965` | merged design + runtime | Adds six read-only summary cards and keeps Basic info + People as the only write-capable areas. |

## 3. Current Production Baseline

All code citations were verified on `origin/main` at `0e06ebf19`.

| Area | Current state | Evidence |
| --- | --- | --- |
| Single production surface | Attendance groups render in `AttendanceView.vue`; People is inside the selected group detail, and member rows are rendered in that table. | `apps/web/src/views/AttendanceView.vue:2949`, `apps/web/src/views/AttendanceView.vue:3078`, `apps/web/src/views/AttendanceView.vue:3177` |
| Member row shape | `mapAttendanceGroupMemberRow` returns membership facts only: `id`, `orgId`, `groupId`, `userId`, `createdAt`. It does not include user labels. | `plugins/plugin-attendance/index.cjs:7289` |
| Member list route | `GET /api/attendance/groups/:id/members` returns paginated `items`, `total`, `page`, and `pageSize`; `items` are the membership facts above. | `plugins/plugin-attendance/index.cjs:25483`, `plugins/plugin-attendance/index.cjs:25501`, `plugins/plugin-attendance/index.cjs:25511` |
| Current loader | The frontend member loader calls the member route without page parameters, stores the first returned page in `attendanceGroupMembers`, and stores `total` separately. | `apps/web/src/views/AttendanceView.vue:15819`, `apps/web/src/views/AttendanceView.vue:15828`, `apps/web/src/views/AttendanceView.vue:15838` |
| Current display | Pending chips and saved member rows display only `userId`; POST and DELETE payloads also use `userId`. | `apps/web/src/views/AttendanceView.vue:3123`, `apps/web/src/views/AttendanceView.vue:3130`, `apps/web/src/views/AttendanceView.vue:3177`, `apps/web/src/views/AttendanceView.vue:3185`, `apps/web/src/views/AttendanceView.vue:15869` |
| Existing picker labels | `AttendanceUserPickerField` already formats picker options with `name`, `email`, and `id`, but the component emits only the selected `userId`. | `apps/web/src/views/attendance/AttendanceUserPickerField.vue:21`, `apps/web/src/views/attendance/AttendanceUserPickerField.vue:90`, `apps/web/src/views/attendance/useAttendanceAdminUsers.ts:36` |
| Existing picker data source | The current picker composable calls `/api/admin/users`, which is guarded by platform-admin access. This must not become the required enrichment path for attendance-admin member tables. | `apps/web/src/views/attendance/useAttendanceAdminUsers.ts:69`, `packages/core-backend/src/routes/admin-users.ts:2606`, `packages/core-backend/src/routes/admin-users.ts:2607` |
| Attendance-scoped resolver | The attendance admin router is already guarded by `attendance:admin`, and its batch resolve route returns `id`, `email`, `name`, and `is_active` for requested user IDs. | `packages/core-backend/src/routes/attendance-admin.ts:313`, `packages/core-backend/src/routes/attendance-admin.ts:356`, `packages/core-backend/src/routes/attendance-admin.ts:365`, `packages/core-backend/src/routes/attendance-admin.ts:371` |
| Resolver query shape | The resolver reads existing `users` rows by requested IDs and reports missing / inactive IDs without mutating attendance membership. | `packages/core-backend/src/routes/attendance-admin.ts:281`, `packages/core-backend/src/routes/attendance-admin.ts:292`, `packages/core-backend/src/routes/attendance-admin.ts:301` |
| Existing test anchor | Current People tests already lock that add-member submits only unique `userIds` through the existing member POST route. | `apps/web/tests/attendance-admin-anchor-nav.spec.ts:246`, `apps/web/tests/attendance-admin-anchor-nav.spec.ts:366` |

## 4. Hard Boundaries

A future member-label enrichment runtime PR must stay inside these boundaries:

1. No new backend route, schema, migration, permission, OpenAPI contract, plugin contract, or attendance table change.
2. No new persisted member label field. `attendance_group_members.user_id` remains the only membership identity fact.
3. No attendance fact writes, schedule writes, punch-method writes, reporting writes, or settings writes.
4. `userId` must remain visible in every saved member row and must remain the only value sent to member add/remove APIs.
5. Labels are UI hints only. They must never be used for identity, duplicate detection, POST payloads, DELETE paths, or audit assertions.
6. Enrichment is scoped to the currently loaded member page and current pending chips. Do not fetch every member page just to label rows.
7. Do not require the platform-admin `/api/admin/users` route for member-table labels. Use the existing attendance-scoped batch resolver if labels are needed for saved rows.
8. Resolver failure, 403, missing users, inactive users, or partial results must degrade to `userId` display rather than hiding member rows or blocking membership edits.
9. Do not expose mobile, department, avatar, role, owner/sub-owner, delegated-admin scope, or external identity state in the People table unless a later design explicitly approves that surface.
10. Do not reintroduce `AttendanceRulesAndGroupsSection.vue` or a second member-management surface.

Any item above requires a separate design and explicit opt-in.

## 5. V1 UX Contract

### 5.1 Member Row Display

Saved member rows should use a two-level display:

- Primary: best-effort label from an approved source, when known.
- Secondary: durable `userId`, always visible.
- Fallback: if no label is known, render the current `userId`-only row.

Recommended label priority:

1. `name` when present and non-empty.
2. `email` when present and non-empty.
3. `userId`.

The row may show a small inactive marker only if the existing resolver returns `is_active === false`. It must not filter inactive users out of the group.

### 5.2 Resolver Flow

After `loadAttendanceGroupMembers()` successfully loads the current page:

1. Collect unique `userId` values from `attendanceGroupMembers`.
2. If the list is empty, skip enrichment.
3. Filter the resolver request to IDs compatible with the resolver's accepted shape. Any non-compatible member ID stays visible as a single-row `userId` fallback instead of making the whole page lookup fail.
4. Call the existing `POST /api/attendance-admin/users/batch/resolve` route with `{ userIds }`.
5. Cache returned labels in component state keyed by `userId`.
6. Render labels for matching rows and fall back for missing / unresolved rows.

This resolver call is read-like but uses the existing POST contract. It must be best-effort: it should not block the member list, it should not clear loaded members, and it should not turn a label lookup failure into a membership failure.

Runtime implementation should clear or refresh the label cache when the selected attendance group changes, because labels are session UI state rather than persisted membership metadata.

### 5.3 Pending Chips And Picker Labels

Pending chips may show labels only from current UI state:

- A picker-selected user may carry its known label into the pending chip if the component exposes the selected item in a frontend-only way.
- Manually pasted IDs must not invent labels.
- If the selected item is not available, the pending chip falls back to `userId`.
- Submit still posts only unique `userIds`.

If a future runtime extends `AttendanceUserPickerField` to emit the selected item, the extension must remain frontend-only and preserve the existing `v-model` behavior for current callers.

### 5.4 Pagination And Counts

The current member loader does not request additional pages. Label enrichment must therefore be honest about scope:

- Resolve labels only for visible loaded rows.
- Keep the existing count distinction, e.g. "Showing N of total".
- Do not imply that unloaded rows have been enriched.
- Do not add load-more or member pagination in this slice unless separately opted in.

### 5.5 Copy Rules

Use operator copy that keeps the fact/hint distinction clear:

- Prefer "User ID" for the durable identifier.
- Prefer "Display label unavailable" or silent `userId` fallback over erroring the row.
- Avoid "profile synced" or "directory verified" unless that data is actually in the approved response.
- Avoid department, role, owner, or device-oriented terms in this slice.

## 6. Proposed Runtime Slice Shape

A future runtime PR should be one frontend-only PR:

| Change | Allowed implementation |
| --- | --- |
| Label cache | Add a local `Map<userId, resolvedUser>` or equivalent state near the existing attendance group member state in `AttendanceView.vue`. |
| Visible-row resolve | After member GET succeeds, call the existing attendance-scoped batch resolver for visible member `userId`s only. |
| Row rendering | Render label + durable `userId`; fallback to current `userId` display when unresolved. |
| Pending chip labels | Optionally carry picker result label into current-session pending chips through a frontend-only picker event or helper. |
| Failure behavior | Treat resolver failures as non-blocking and keep member add/remove usable. |
| Tests | Extend production `AttendanceView.vue` tests in `attendance-admin-anchor-nav.spec.ts` and/or `attendance-admin-regressions.spec.ts`. |

Do not touch backend, migrations, OpenAPI contracts, plugin runtime, permission definitions, extracted component paths, schedule modules, punch settings, or reporting code in the V1 runtime PR.

## 7. Test Matrix

| ID | Requirement | Test target |
| --- | --- | --- |
| L1 | Loading saved members calls the existing attendance-scoped batch resolver with only the currently loaded `userId`s. | Frontend test with mocked GET members + resolver POST. |
| L2 | A resolved row renders the label and still renders the `userId`. | Frontend DOM assertion in the People table. |
| L3 | Missing / unresolved users fall back to `userId` without hiding rows. | Frontend resolver fixture with `missingUserIds`. |
| L4 | Resolver 403 / 500 does not clear loaded members and does not block add/remove controls. | Frontend mocked failure test. |
| L5 | Add-member POST body still contains only `userIds`; labels never enter payloads. | Existing Slice B test extended with resolved labels. |
| L6 | Remove-member action still targets the member `userId`, not a label. | Frontend mocked DELETE path assertion. |
| L7 | Pending chip label, if present, comes from picker state; manually typed IDs remain ID-only. | Frontend test. |
| L8 | Two different `userId`s with the same display label remain distinct and can both be staged/submitted; duplicate logic keys only on `userId`. | Frontend fixture with colliding labels. |
| L9 | Total-vs-visible copy remains honest when `total > items.length`; enrichment covers only visible rows. | Frontend test with first-page member fixture. |
| L10 | Runtime PR has no backend, schema, migration, permission, OpenAPI, plugin, or route diff. | Reviewer diff check. |
| L11 | `AttendanceRulesAndGroupsSection.vue` remains retired; no second People implementation returns. | Source grep / reviewer diff check. |

## 8. Explicitly Deferred

These are not part of this design:

- new enriched member-list backend response;
- new member-enrichment endpoint;
- persisting labels in `attendance_group_members`;
- loading every member page for enrichment;
- member pagination / load-more UI;
- owner/sub-owner permissions;
- department filters, role filters, or delegated admin scopes;
- export/copy/import of group settings;
- fixed-schedule modeling or weekly schedule matrix;
- group-specific punch method configuration;
- location / Wi-Fi / hardware / photo / face verification;
- reporting or comprehensive-hours writes;
- external integration work.

## 9. Acceptance For This Design

This design lock is complete when:

- it records the current member table and existing user-resolution contracts;
- it chooses a no-new-backend V1 path for readable saved member rows;
- it keeps `userId` as the durable membership fact;
- it scopes enrichment to visible rows and current-session UI state;
- it records failure, privacy, pagination, and test expectations;
- it adds no runtime code, test code, schema, migrations, operational scripts, or production writes.
