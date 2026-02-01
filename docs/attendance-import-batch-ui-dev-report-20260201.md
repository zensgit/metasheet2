# Attendance Import Batch UI Dev Report (2026-02-01)

## Summary
- Updated the Attendance admin import flow to use the commit-token API (`prepare → commit`).
- Added UI for import batch listing, item inspection, and rollback controls.
- Added minimal admin permission handling for import-related actions.

## Changes
- `apps/web/src/views/AttendanceView.vue`
  - `runImport` now calls `/api/attendance/import/prepare` then `/api/attendance/import/commit`.
  - Added import batch list and batch item list with pagination + rollback action.
  - Added per-item preview snapshot viewer for batch items.
  - Added batch status filter and search input.
  - Added snapshot copy/download actions for batch item preview.
  - Added admin permission guard for import endpoints.
  - Added status chips for `committed` and `rolled_back`.

## Notes
- Batch list is loaded in `loadAdminData`, and can be manually reloaded.
- Rollback updates the batch status and reloads list/items.
