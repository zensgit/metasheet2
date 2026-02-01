# Attendance Import Commit/Rollback Verification (2026-02-01)

## Environment
- Backend: `pnpm --filter @metasheet/core-backend dev`
- DB: `postgresql://metasheet:***@localhost:5435/metasheet`
- Plugin: `plugin-attendance` enabled

## Migration
- Applied: `zzzz20260131160000_create_attendance_import_tables`
- Verified tables:
  - `attendance_import_batches`
  - `attendance_import_items`
  - `attendance_records.source_batch_id`

## API Verification
Used dev-token for admin user (token not recorded).

1) **Prepare commit token**
- `POST /api/attendance/import/prepare`
- Result: `ok: true`, commit token issued

2) **Commit import batch**
- `POST /api/attendance/import/commit`
- Payload: 1 row (`workDate=2026-01-30`, `firstInAt`, `lastOutAt`, `workMinutes`)
- Result: `ok: true`, `imported: 1`, `batchId` returned

3) **List batches + items**
- `GET /api/attendance/import/batches`
- `GET /api/attendance/import/batches/:id`
- `GET /api/attendance/import/batches/:id/items`
- Result: list returned total >= 1, batch status `committed`, items total `1`

4) **Rollback import batch**
- `POST /api/attendance/import/rollback/:batchId`
- Result: `ok: true`, `status: rolled_back`

## Result
- Commit/rollback flow works end-to-end with batch persistence.
- Import rows are linked to `source_batch_id`, enabling cleanup.
