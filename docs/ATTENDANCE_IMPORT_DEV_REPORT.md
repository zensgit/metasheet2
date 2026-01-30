# Attendance Import Dev Report (DingTalk CSV)

Date: 2026-01-30

## Scope
- Extend attendance import to accept DingTalk CSV-derived payloads (`entries`) and per-row user resolution via `userMap`.
- Expand default field mapping for CSV daily summary columns.
- Add a new custom rule sample using `attendance_group`.
- Document CSV import payloads and mappings.

## Key Changes
- **Backend import pipeline** (`plugins/plugin-attendance/index.cjs`)
  - Added `entries`, `userMap`, `userMapKeyField`, `userMapSourceFields` to import schema.
  - Added `buildRowsFromEntries()` to group punch events into per-day rows.
  - Added per-row `userId` resolution via `userMap` + empNo/sourceUserKey.
  - Updated import/preview flows to use row-specific `userId`.
  - Expanded default mapping for DingTalk CSV summary fields (Chinese headers).
  - Updated import template example to show `dingtalk_csv` payload with `entries`.

- **Frontend** (`apps/web/src/views/AttendanceView.vue`)
  - Added sample rule `group_attention` (attendance_group-based) to custom template examples.

- **OpenAPI** (`packages/openapi/src/paths/attendance.yml`)
  - Added new request fields: `entries`, `userMap`, `userMapKeyField`, `userMapSourceFields`.

- **Docs**
  - Added `docs/ATTENDANCE_IMPORT_DINGTALK_CSV.md` with payload examples and mapping notes.
  - Added conversion helper: `scripts/convert-dingtalk-csv-to-import.mjs`.
  - Added default `statusMap` in the helper (includes `外勤`, `外出`, `出差`, `休息`, `补卡`) to normalize DingTalk status strings.

## Generated Artifacts
- `artifacts/attendance-import-payload-核对-20260120-20260127.json` (entries + userMap)
- `artifacts/attendance-import-payload-20251201-20251231.json` (entries + userMap)
- `artifacts/attendance-import-rows-核对-20260120-20260127.json` (rows + userMap)
- `artifacts/attendance-import-rows-核对-20260120-20260127-summary.json` (rows count per day)
- `artifacts/attendance-import-rows-import-2026-01-20.json` … `attendance-import-rows-import-2026-01-27.json` (row import results)

## Files Touched
- `plugins/plugin-attendance/index.cjs`
- `apps/web/src/views/AttendanceView.vue`
- `packages/openapi/src/paths/attendance.yml`
- `docs/ATTENDANCE_IMPORT_DINGTALK_CSV.md`

## Notes
- `attendance_group` is used by the rule engine `scope` and should map to `attendanceGroup` or `attendance_group`.
- For multi-user CSV, provide `userMap` keyed by empNo/工号; the import resolves per-row `userId`.
