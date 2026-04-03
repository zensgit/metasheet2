# Platform UI Follow-up Design

Date: 2026-04-03

## Context

Platform deploy feedback surfaced three real UX issues:

1. The browser title for `/attendance` stayed in English even in Chinese locale.
2. Attendance `Overview` and `Reports` were effectively the same surface because `reports` only deep-linked into the overview page.
3. Entering `/approvals` could feel like a forced logout because the page boot requests used the shared unauthorized redirect path.

## Decisions

### 1. Localize route document titles

- Extend route meta with `titleZh`.
- Add a shared `resolveRouteDocumentTitle()` helper.
- Use it in the router guard and in `App.vue` so locale switches also update the browser title after mount.

### 2. Split attendance reports from overview

- Add `AttendanceReportsView.vue`.
- Route the `reports` tab in `AttendanceExperienceView.vue` to that dedicated view instead of reusing `AttendanceOverview.vue`.
- Extend `AttendanceView.vue` with a `reports` mode that renders report-focused header/filter UX and only the request report surface, while keeping overview behavior intact.

### 3. Keep approval-center failures from clearing the whole session

- Update `ApprovalInboxView.vue` to call `/api/approvals/*` with `suppressUnauthorizedRedirect: true`.
- Surface the page-level error in the inbox instead of letting a module-specific 401 clear the global auth token.
- Localize the approval center shell copy for Chinese users.

### 4. Keep PLM navigation hidden when PLM is disabled

- Gate `/plm/audit` links behind the same `canUsePlm` feature check already used for `/plm`.

## Non-goals

- No backend approval-route logic changes.
- No redesign of approval workflows.
- No attendance data-contract changes.
