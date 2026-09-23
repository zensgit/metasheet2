# 考勤报表导出截断披露与快照区间口径 — 2026-09-23

Issues: #5991 (export silent truncate), #5987 (snapshot page-scoped metrics).
Out of scope: overview #6010, admin lists #6012, and open PRs #6004–#6008 / #6010 / #6012.

## Problem

`GET /api/attendance/export` defaults `limit` to 1000 and hard-caps at 5000. The reports CSV/Excel buttons omit `limit` and `status`, and the success copy does not say how many rows were written. A range larger than 1000 downloads as a success with rows missing.

The report snapshot card labels record count, flagged count, and work minutes as if they were the filtered range. They are `filteredRecords` on the current page (`recordsPageSize = 20`). The adjacent Management Metrics card uses `GET /api/attendance/summary` for the whole range, so the two cards disagree once the range has more than one page.

## Export contract

- Safety cap stays **5000** rows (`ATTENDANCE_EXPORT_MAX_ROWS`). No unbounded paging and no higher cap.
- Omitted `limit` now means the cap (5000), not 1000. Callers that want fewer rows still pass `limit`.
- Optional `status` query: empty or `all` exports every status in the range. Any other value must match `^[a-z][a-z0-9_]{0,63}$` or the route returns 400. The value is a bound parameter (`ar.status = $n`).
- Before the limited SELECT, the route runs `COUNT(*)` with the same user, org, date, and status predicate.
- Every successful response sets:
  - `X-Attendance-Export-Total` — matched rows
  - `X-Attendance-Export-Returned` — rows written
  - `X-Attendance-Export-Limit` — applied cap
  - `X-Attendance-Export-Truncated` — `true` when matched > returned
  - `X-Attendance-Export-Status` — status token or `all`
- JSON keeps `data.total` as the returned length (existing callers) and adds `matchedTotal`, `returned`, `limit`, `truncated`, `status`.
- CSV (and therefore the client-built Excel file) always appends one footer line beginning with `# META attendance_export`. It is not a record. Data rows stay above it; the header row stays line 1.
- The reports UI requests `limit = min(recordsTotal, 5000)` when the loaded range total is known, otherwise 5000, and passes the record-status pill when it is not `all`. The status bar and a persistent disclosure line state returned/matched, and use the error status when truncated.
- The import-override backup button is unchanged. It still omits `limit`/`status`, so it inherits the new default cap and the CSV footer.

## Snapshot contract

Request-side snapshot numbers stay the full request-report aggregate after the request pills.

The three record numbers use the loaded summary, the same rows Management Metrics already shows:

- range records = `total_days + off_days` (the summary query partitions every row in the range)
- range flagged = `late_days + early_leave_days + late_early_days + partial_days + absent_days + adjusted_days`
- range work minutes = `total_minutes`

They do not follow the current page or the record-status pill. The pill still filters the records table and, after this change, the export. `off_days` is the summary's non-counted-day bucket, not a raw `status = 'off'` recount. That is the summary contract, not a second definition.

## Non-goals

- Completing an export past 5000 by looping pages into memory.
- Server-side status facets on the summary payload.
- Changing record-list pagination or the "current page only" status-mix card.
