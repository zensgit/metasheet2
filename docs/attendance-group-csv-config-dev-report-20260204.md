# Attendance: Groups + CSV + Config (Dev Report)

Date: 2026-02-04

## Scope
- Attendance group management (groups + members)
- CSV import enhancements (commit token flow + batch visibility)
- Default + user-configurable rules with auto-mapping by `attendance_group`

## Backend
- Added group member API endpoints:
  - `GET /api/attendance/groups/:id/members`
  - `POST /api/attendance/groups/:id/members`
  - `DELETE /api/attendance/groups/:id/members/:userId`
- Rule set auto-binding for imports now supports `attendance_group` / `考勤组` fields when `ruleSetId` is omitted.
- Import preview/commit/import share the same rule-selection logic (per-row).
- Added rule engine cache per rule set when applying per-row overrides.

## Frontend (Attendance admin)
- New **Group members** section with add/remove by user IDs.
- Import flow updated to:
  - `POST /api/attendance/import/prepare` for commit token
  - `POST /api/attendance/import/commit` primary path
  - fallback to `/api/attendance/import` when commit endpoint unavailable
- Added **Import batches** table, item viewer, and rollback actions.

## Files changed
- `plugins/plugin-attendance/index.cjs`
- `apps/web/src/views/AttendanceView.vue`

## Notes
- Dev backend container expects DB hostname `postgres`. Ensure the postgres container is on the same network with alias `postgres`.
- Local validation used the dev-token route (`/api/auth/dev-token`) plus a `user_roles` row for `admin-dev` to satisfy RBAC checks.
