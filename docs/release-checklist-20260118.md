# Release Checklist 2026-01-18

## Pre-Release
- Deploy backend first (includes migrations + API updates).
- Verify env vars: DB/Redis/Observability.
- Confirm DB backup/rollback plan.

## Migrations
- Run: `pnpm --filter @metasheet/core-backend migrate`
- Verify tables exist:
  - `spreadsheets`, `sheets`, `cells`, `cell_versions`, `named_ranges`
  - `attendance_*`, `user_orgs`, `system_configs`, `bpmn_*`

## API Validation
- Spreadsheets:
  - `GET /api/spreadsheets`
  - `POST /api/spreadsheets`
  - `GET /api/spreadsheets/{id}`
  - `GET /api/spreadsheets/{id}/sheets/{sheetId}/cells`
  - `PUT /api/spreadsheets/{id}/sheets/{sheetId}`
- Attendance:
  - `GET /api/attendance/records`
  - `POST /api/attendance/punch`
  - `GET /api/attendance/summary`
- Plugins:
  - `GET /api/plugins` (ensure `plugin-attendance` is active)

## Frontend Validation
- Grid: edit cell -> save -> refresh -> value persists.
- Attendance: plugin entry visible; punch/summary work.

## Optional Cleanup
- Remove local backups if no longer needed:
  - `/tmp/metasheet2-clean-backup-20260118-123533.patch`
  - `/tmp/metasheet2-clean-untracked-20260118-123533.tar`
