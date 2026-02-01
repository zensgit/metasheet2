# Attendance Import Commit/Rollback Dev Report (2026-01-31)

## Summary
- Added commit-token based import flow with batch tracking and rollback support.
- Implemented import batch persistence schema and related indexes.
- Ensured attendance records can be linked to import batches for cleanup.

## Changes
- New migration adds:
  - `attendance_import_batches`
  - `attendance_import_items`
  - `attendance_records.source_batch_id` + index
- New import commit flow:
  - `POST /api/attendance/import/prepare` -> commit token
  - `POST /api/attendance/import/commit` -> batch + records
  - `POST /api/attendance/import/rollback/:id`
  - Read endpoints for batches and items
- Commit endpoint now always requires `commitToken`.

## Files
- `plugins/plugin-attendance/index.cjs`
  - commit token helpers
  - new commit/rollback endpoints
  - batch/record linking via `source_batch_id`
- `packages/core-backend/src/db/migrations/zzzz20260131160000_create_attendance_import_tables.ts`

## Notes
- Import batches default to `status=committed` and update to `rolled_back` on rollback.
- Rollback removes `attendance_records` by `source_batch_id` and updates batch status.
- Commit flow stores per-row snapshots in `attendance_import_items` for audit/debug.
