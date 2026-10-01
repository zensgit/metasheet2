# Overview range window (attendance silent truncation)

Date: 2026-09-23
Branch: `cursor/attendance-overview-range-window-bb77`
Issues: #5993, #5994, #5997

## Problem

Employee overview treats three paged reads as if the first page were the whole `from`–`to` range:

| Surface | Loader | Old page | What goes wrong when `total` is larger |
| --- | --- | --- | --- |
| Calendar chips | `loadRecords` | 20 | Earlier work dates render as empty cells. Summary still aggregates the full range. |
| Attention / pending / follow-up | `loadRequests` | 10 | Pending counts and the latest follow-up only see the first page. `total` is ignored. |
| Anomaly table + batch resolve | `loadAnomalies` | 50 | The status line uses `items.length`. Rows past 50 never become selectable. |

The attendance API already returns `items` + `total` and caps `pageSize` at 200 (`parsePagination`). This change does not alter that contract.

Out of scope: #5995 payroll lists, #5998 shifts/rules, #6000 shift-swap/absence candidates, #6002 import batches, #5991 export `limit=1000`, #5987 report snapshot page-scoped metrics. The reports record card keeps its 20-row pager.

## Strategy

One rule for the three overview consumers:

1. Choose a page size that covers the visible range, then stop at the API cap.
   - Records: `min(200, max(31, inclusive day span))`. One current row per work date, so the default ~31-day window and a calendar month fit in one response. 31 replaces the old silent cap of 20.
   - Requests: `200`. Requests are not one-per-day; the old cap of 10 dropped pending rows inside a normal month. 200 is the largest page the contract allows.
   - Anomalies: `min(200, max(50, inclusive day span))`. Never smaller than the old page, and large enough for a quarter. A year still stops at 200.
2. Read `total`. The window is truncated when the fetched row count is still below `total`. A missing `total` is treated as the returned length, so older fixtures do not grow a false banner. An empty load-more page turns the notice off.
3. Show a notice on that surface and a load-more control that requests the next page and appends it (deduped by work date, request id, or anomaly record id). Each click is one capped page. There is no automatic loop.
4. Pending chips and follow-up keep counting the loaded set. When the request window is truncated, the notice says the pending number is only that set. When it is not truncated, the count is the range.
5. Batch resolve still submits at most 50 selected rows (existing batch lock). It can only select rows that are loaded. The anomaly notice says later rows are outside the list until load-more.

Reports mode keeps `pageSize=20` and the existing record pager. Overview and reports are separate `AttendanceView` instances.

## Non-goals

- No new endpoint, query parameter, or write path.
- No unbounded client fetch.
- No change to summary aggregation, report snapshot metrics, or export limits.
