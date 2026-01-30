# Attendance Import Template Extension - Verification Report (2026-01-30)

## Local Script Checks
- Ran `scripts/attendance/dingtalk-csv-to-import.mjs` on:
  - `核对(2).csv` → generated 3080 rows.
  - `浙江亚光科技股份有限公司_每日汇总（新）_20251201-20251231(2) (1).csv` → generated 11966 rows.
- Verified header auto-detection and date normalization (YY-MM-DD → 2025-12-01).

## Import Preview (API)
- Previewed 200 `rows` from `核对(2).csv` with template mapping + statusMap:
  - Status summary: normal=180, adjusted=16, partial=2, late=2.
- Previewed 400 `entries` (grouped to 235 rows) from `dingtalk-csv-entries-核对-20260120-20260127.json`:
  - Status summary: early_leave=128, partial=68, off=24, normal=15.

## Notes
- Backend import endpoints were not invoked during this verification (DB not required for script run).
- `statusMap` must be passed as a flat object (not wrapped in `{statusMap:{...}}`).
