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

### UI
- ✅ Attendance page renders at `/p/plugin-attendance/attendance`.
- ✅ Admin sections load (groups / members / import / batches visible).

## Notes / Caveats
- UI actions require auth token; without login, admin data is not loaded.
- Import preview/commit was tested with a minimal payload and `attendance_group` value.
