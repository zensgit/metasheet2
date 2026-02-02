# Attendance Integration + CSV Import Dev Report (2026-02-02)

## Scope
- Add CSV import support to attendance imports (preview/commit/import).
- Add attendance integration management and DingTalk sync endpoints.
- Persist profile/metrics/source metadata on imported records.
- Extend admin UI to load CSV files and surface CSV warnings.
- Update OpenAPI schemas for new payload fields + integration APIs.

## Backend Changes
- **CSV parsing + normalization**
  - Added CSV parser with auto header detection and workDate normalization.
  - Supports `csvText` + `csvOptions` (delimiter, headerRowIndex).
- **Import pipeline updates**
  - Preview/commit/import accept `csvText` and return `csvWarnings`.
  - `buildRowsFromDingTalk` now preserves `userId` when provided.
  - User profile fields resolved from `userMap` and embedded in record meta.
- **Integration management**
  - New endpoints:
    - `GET/POST /api/attendance/integrations`
    - `PUT/DELETE /api/attendance/integrations/:id`
    - `GET /api/attendance/integrations/:id/runs`
    - `POST /api/attendance/integrations/:id/sync`
  - DingTalk sync flow fetches column values, converts to rows, commits batch.
- **DB migration**
  - `attendance_integrations` and `attendance_integration_runs` tables.

## Frontend Changes
- Attendance admin import panel:
  - CSV file input + optional header row + delimiter inputs.
  - “Load CSV” button injects `csvText` into payload.
  - CSV warnings displayed alongside preview results.

## OpenAPI Updates
- Added schemas for `AttendanceIntegration` and `AttendanceIntegrationRun`.
- Import payloads include `mappingProfileId`, `commitToken`, `engine`, `csvText`, `csvOptions`.
- Preview responses include `csvWarnings`.

## Files Touched
- `plugins/plugin-attendance/index.cjs`
- `apps/web/src/views/AttendanceView.vue`
- `packages/core-backend/src/db/migrations/zzzz20260202093000_create_attendance_integrations.ts`
- `packages/openapi/src/base.yml`
- `packages/openapi/src/paths/attendance.yml`

## Notes / Follow-ups
- DingTalk integration config currently expects `appKey`, `appSecret`, `userIds`, and `columnIds`.
- No retry/backoff for DingTalk API calls yet (can be added if needed).
