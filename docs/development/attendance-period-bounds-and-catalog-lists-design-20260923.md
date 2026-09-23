# Attendance period bounds and catalog lists (#6016, #6017)

Date: 2026-09-23. Base: `main` `261835ad2dea`. Draft only; do not merge.

#6012’s admin-list helper and #6014’s timezone contract are not on this base. This slice reuses the on-main pieces (`formatAttendanceDateKey`, `getZonedParts`, `parsePagination` max 200) and adds a minimal equivalent for these two bugs only.

## #6016 — period defaults follow an attendance IANA zone

Comprehensive-hours preview defaults (year, month, quarter, custom from/to) and the payroll-generate anchor were taken from the browser `Date` calendar. `resolvePayrollWindow` then read UTC year/month/day and ignored `template.timezone`, while the UI still labeled that zone as the generate context.

Contract:

- A `YYYY-MM-DD` anchor is a calendar literal. It is not reinterpreted in another zone. The zone chooses which calendar day “today” is; start/end stay date-only arithmetic (`startDay` / `endDay` / `endMonthOffset`).
- An instant (omitted create anchor → `new Date()`, or a non-date timestamp string) uses the template IANA calendar. Missing or invalid template zone falls back to the org default rule IANA, then `UTC`.
- A `Date` at exact UTC midnight stays on the UTC calendar. `parseDateInput('YYYY-MM-DD')` and month stepping produce those values, including payroll-cycle window verification. Shifting them west of UTC would move a correct cycle.
- Frontend comprehensive-hours defaults use the org default rule zone after `GET /api/attendance/rules/default` returns a valid IANA zone. Before that, they use the overview “today” zone (`resolvedAttendanceTimezone`, the self-service runtime rule). They do not use the browser zone.
- The payroll-generate anchor uses the selected template zone, otherwise the default template (else the first template), otherwise the same attendance zone. Untouched defaults refresh when that zone arrives. An edited year, month, quarter, from, to, or anchor stays.

Out of scope: holiday-range defaults and the missed-punch reminder `toISOString().slice(0, 10)` day. Those are the siblings named on #6016, not this slice.

## #6017 — approval flows and rule sets disclose truncation

`GET /api/attendance/approval-flows` and `GET /api/attendance/rule-sets` already return `total` with `parsePagination` default 50 and max 200. The admin loaders requested no page and ignored `total`.

Contract for these two lists only:

- Request `page=1&pageSize=200`.
- Read `total`. When `total > loaded`, show “Showing x of N” / “已显示 x/N” and a Load more button that appends the next page.
- Stop on an empty page, a page that adds no new ids, or 25 pages (5,000 rows), and say the list cap was reached.
- Outdoor and schedule-dispatch flow pickers share the approval-flow array, so they stay short until Load more. The picker shows the same notice.

No `maxPageSize` change. No new route.
