# Attendance admin list silent truncation — design (2026-09-23)

Tracks #6002, #5998, #6000, and #5995. Out of scope: #5991 export `limit=1000`, #5987 report-snapshot metrics, and the overview trio already covered by #6010.

## Problem

These admin and request lists call paginated attendance APIs, then render `items` as if that page were the full set. `parsePagination` defaults to `pageSize=50` (max 200) and every response includes `total`. The UI never reads `total`, so rows past the first page disappear with no notice.

| Surface | Loader | First page today |
| --- | --- | --- |
| Import batches and batch items | `useAttendanceAdminImportBatches` | omitted (default 50). Full-batch impact already pages. |
| Shifts, rotation rules, rotation assignments, shift assignments, leave types, overtime rules | `AttendanceView.vue` (live) and the unused scheduling composable for the first four | omitted (default 50) |
| Payroll cycles and templates | `AttendanceView.vue` (live) and `useAttendanceAdminPayroll` | omitted (default 50) |
| Shift-swap requests | `loadShiftSwapRequests` | hard-coded 20 |
| Shift-swap assignment options | `loadShiftSwapAssignmentOptions` | 200, `total` ignored |
| Missed-punch reminder candidates | `loadMissedPunchReminderCandidates` | hard-coded 50; select-all covers only that page |

## Decision

Keep the API contracts. Do not raise `maxPageSize`.

1. Request an explicit first page of **200** (the existing cap) so a normal admin catalog fits in one response.
2. Read `total`. When `total > loaded`, show “已显示 x/N” and a **Load more** button that appends the next page.
3. Stop automatic walking. Each click loads one page. Stop at **25 pages** (5,000 rows), on an empty page, or when a page adds no new ids. Say so in the notice.
4. Missed-punch select-all stays “loaded rows only”. The confirm dialog shows loaded/total. Enqueue is unchanged.
5. Import “view items” uses the same page + load-more path. `fetchAllImportBatchItems` stays the explicit full-impact / CSV fallback and is still capped by its existing page loop.

Live binding for payroll and scheduling remains the inline loaders in `AttendanceView.vue`. The composables get the same page contract so they do not keep the silent default.

## Non-goals

No new routes, no query-contract change, no unbounded prefetch, no export-limit change.
