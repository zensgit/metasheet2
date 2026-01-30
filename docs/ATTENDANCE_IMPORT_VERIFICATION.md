# Attendance Import Verification

Date: 2026-01-29

## Checks Performed
- **Syntax check**: `node --check plugins/plugin-attendance/index.cjs` ✅
- **Sample payload review**: verified `payloadExample` in `/api/attendance/import/template` now uses `dingtalk_csv` + `entries`.
- **Field mapping**: confirmed CSV headers map to import targets (see `docs/ATTENDANCE_IMPORT_DINGTALK_CSV.md`).
- **Preview (partial rows)**: executed preview with 200 rows (2026-01-20) and mapping applied successfully.
- **Preview (entries + userMap)**: executed preview with 1066 entries (2026-01-20) using `dingtalk_csv` + `userMap`; 342 items returned with per-user IDs resolved.
- **Import (entries + userMap)**: imported 342 rows for 2026-01-20 using the same payload.
- **Import (entries, 2025-12)**: imported daily slices successfully:
  - 2025-12-01 → 328 rows
  - 2025-12-02 → 333 rows
  - 2025-12-03 → 333 rows

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
