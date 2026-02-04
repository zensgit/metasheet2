# Attendance: Groups + CSV + Config (Verification Report)

Date: 2026-02-04

## Environment
- Local dev backend: `http://localhost:8900`
- Local dev web: `http://localhost:8899`
- DB: `metasheet-dev-postgres` attached to `metasheet2_default` with alias `postgres`

## Verification Summary
### API (dev-token + admin role)
- ✅ List groups: `GET /api/attendance/groups`
- ✅ Group members: add/list/remove via `/api/attendance/groups/:id/members`
- ✅ Import commit token: `POST /api/attendance/import/prepare`
- ✅ Import preview: `POST /api/attendance/import/preview`
- ✅ Import commit: `POST /api/attendance/import/commit`
- ✅ Import batches: `GET /api/attendance/import/batches`
- ✅ Import rollback: `POST /api/attendance/import/rollback/:id`

### UI
- ✅ Attendance page renders at `/p/plugin-attendance/attendance`.
- ✅ Admin sections load (groups / members / import / batches visible).

## Notes / Caveats
- UI actions require auth token; without login, admin data is not loaded.
- Import preview/commit was tested with a real CSV sample (first 5 lines) from the DingTalk daily summary file. \n  The sample CSV appears to be tab-delimited, so preview reported missing required fields when parsed with default delimiter. \n  Commit succeeded with 0 imported rows and rollback completed successfully. Adjust `csvOptions.delimiter` (e.g., `\\t`) for full import.
