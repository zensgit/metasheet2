# Attendance: Groups + CSV + Config (Verification Report)

Date: 2026-02-04

## Environment
- Local dev backend: `http://localhost:8900`
- Local dev web: `http://localhost:8899`
- DB: `metasheet-dev-postgres` attached to `metasheet2_default` with alias `postgres`
- Remote (test): `http://142.171.239.56:8081`

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

### Remote API (admin token)
- ✅ `GET /api/auth/me`
- ✅ `GET /api/attendance/groups`
- ✅ `GET /api/attendance/import/template`
- ✅ `POST /api/attendance/import/preview` (sample payload)

## Notes / Caveats
- UI actions require auth token; without login, admin data is not loaded.
- The DingTalk CSV contains report metadata in the first two lines, so the header row index must be `2` (0-based).
- Full import verification using the real CSV file succeeded with `csvOptions.delimiter: ','` and `headerRowIndex: 2`:
  - Commit: `imported=11769`, `skipped=197`
  - Rollback: `deleted=11769`, status `rolled_back`
