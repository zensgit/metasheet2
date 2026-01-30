# Attendance Import Verification

Date: 2026-01-29

## Checks Performed
- **Syntax check**: `node --check plugins/plugin-attendance/index.cjs` ✅
- **Sample payload review**: verified `payloadExample` in `/api/attendance/import/template` now uses `dingtalk_csv` + `entries`.
- **Field mapping**: confirmed CSV headers map to import targets (see `docs/ATTENDANCE_IMPORT_DINGTALK_CSV.md`).
- **Preview (partial rows)**: executed preview with 200 rows (2026-01-20) and mapping applied successfully.
- **Preview (entries + userMap)**: executed preview with 1066 entries (2026-01-20) using `dingtalk_csv` + `userMap`; 342 items returned with per-user IDs resolved.
- **Import (entries + userMap)**: imported 342 rows for 2026-01-20 using the same payload.
- **Import (entries, 2026-01-21~2026-01-27)**:
  - 2026-01-21 → 340 rows
  - 2026-01-22 → 336 rows
  - 2026-01-23 → 330 rows
  - 2026-01-24 → 232 rows
  - 2026-01-25 → 65 rows
  - 2026-01-26 → 329 rows
  - 2026-01-27 → 334 rows
  - Summary: `artifacts/attendance-import-summary-20260120-20260127.json`
- **Import (entries, 2025-12)**: imported daily slices successfully:
  - 2025-12-01 → 328 rows
  - 2025-12-02 → 333 rows
  - 2025-12-03 → 333 rows
  - 2025-12-04 → 337 rows
  - 2025-12-05 → 335 rows
  - 2025-12-06 → 330 rows
  - 2025-12-07 → 93 rows
  - 2025-12-08 → 333 rows
  - 2025-12-09 → 337 rows
  - 2025-12-10 → 330 rows
  - 2025-12-11 → 333 rows
  - 2025-12-12 → 331 rows
  - 2025-12-13 → 227 rows
  - 2025-12-14 → 87 rows
  - 2025-12-15 → 330 rows
  - 2025-12-16 → 335 rows
  - 2025-12-17 → 338 rows
  - 2025-12-18 → 335 rows
  - 2025-12-19 → 336 rows
  - 2025-12-20 → 332 rows
  - 2025-12-21 → 93 rows
  - 2025-12-22 → 333 rows
  - 2025-12-23 → 337 rows
  - 2025-12-24 → 338 rows
  - 2025-12-25 → 333 rows
  - 2025-12-26 → 335 rows
  - 2025-12-27 → 330 rows
  - 2025-12-28 → 83 rows
  - 2025-12-29 → 333 rows
  - 2025-12-30 → 331 rows
  - 2025-12-31 → 338 rows
  - Summary: `artifacts/attendance-import-summary-202512.json`

## Manual Verification Steps (when DB is available)
1. Open Attendance → Admin → Import.
2. Click **Load template** and confirm `payloadExample` shows `source: dingtalk_csv` with `entries`.
3. Paste real payload from `dingtalk-csv-entries-*.json` and `dingtalk-csv-userid-map-核对.json`.
4. Click **Preview** and verify:
   - `userId` resolved correctly per row.
   - `firstInAt`/`lastOutAt` populated.
   - `attendanceGroup`, `department`, `roleTags` surfaced in engine evaluation.
5. Click **Import** to persist records.

## Known Constraints
- If the DB is offline, preview/import will return `DB_NOT_READY` and cannot be validated end-to-end.
- Current pre-prod backend may reject `source: dingtalk_csv` until it is deployed; use `source: dingtalk` for preview on old schema.
- Large entry payloads can hit `413 Request Entity Too Large` on nginx; use smaller slices or raise `client_max_body_size`.
