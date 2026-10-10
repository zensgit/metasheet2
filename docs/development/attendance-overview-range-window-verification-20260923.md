# Overview range window verification

Date: 2026-09-23
Branch: `cursor/attendance-overview-range-window-bb77`
Base: `main` @ `261835ad2`

## What was checked

The overview loaders no longer treat a fixed first page as the whole range.

- Default inclusive window `2026-08-24`..`2026-09-23` is 31 days. The record page size is 31, so 25 records in that window are not truncated. The old page of 20 still produces the calendar notice (`20 of 25`, earlier days missing from the grid).
- A 365-day record window stops at page size 200, shows the notice, and the next page appends the rest and clears it.
- Twelve requests, with the pending row at index 11, fit in the overview page of 200. A page of 10 does not, and the notice says the pending count is only the loaded set (`0 pending` of `10 of 12`).
- Eighty anomalies fit in the year-sized page of 200. Two hundred of 240 stay truncated until load-more, and the notice says batch resolve can only select loaded rows.
- A short page whose `total` is still larger is truncated. An empty follow-up page clears the notice. A payload with no `total` uses the returned length and does not invent a banner.
- `OverviewRangeNotice` stays hidden without a note and emits load-more when the note is set.
- The employee workspace renders that note beside the request chips and emits `loadMoreRequests`.

Reports record paging stays on `REPORT_RECORDS_PAGE_SIZE` (20). No attendance route or query parameter was added.

## Commands

```text
pnpm install --filter @metasheet/web... --frozen-lockfile
pnpm --filter @metasheet/web exec vitest run --watch=false tests/attendance-overview-range-window.spec.ts
pnpm --filter @metasheet/web exec vitest run --watch=false \
  tests/attendance-selfservice-dashboard.spec.ts \
  tests/attendance-reports-analytics.spec.ts \
  tests/attendanceEmployeeWorkspacePresentation.spec.ts \
  tests/attendance-overview-priority.spec.ts \
  tests/attendance-caliber-transparency.spec.ts
```

## Results

- `attendance-overview-range-window.spec.ts`: 9 passed.
- Related overview/report specs: `attendance-selfservice-dashboard` 85, `attendance-reports-analytics` 7, `attendanceEmployeeWorkspacePresentation` 18, `attendance-overview-priority` 19, `attendance-caliber-transparency` 7. All passed.
- `attendance-record-timeline.spec.ts` fails the same way on unmodified `main` `AttendanceView.vue` (overview default has no record "Details" button). Not part of this change.

## Not exercised

No browser pass against a running attendance API. Disclosure copy and the load-more control were checked in jsdom. The page-size choice was not sent to `GET /api/attendance/records|requests|anomalies`.

## Open questions

- Batch submit stays capped at 50 selected rows. Load-more makes later anomaly rows selectable; it does not raise that cap.
- Pending counts are the loaded set. They match the range only when the request window is not truncated. There is no extra `status=pending` query.
- The client does not walk pages by itself. Past 200 rows, the user loads one capped page at a time.
- One current row per work date is the calendar sizing assumption. Extra rows for the same date collapse on that date, and `total` still drives the notice.
