# Attendance Report Surface Analytics Design

## Goal

Deliver a small frontend-only Report 2.0 slice on top of the existing attendance reports shell without changing backend APIs or loading paths.

## Scope

- Keep `Overview` and `Reports` split introduced in `#626`.
- Improve `Reports` only, using data already loaded inside `AttendanceView.vue`:
  - `requestReport`
  - `records`
  - `recordsTotal`
- Add:
  - summary cards for report scanability
  - local filters for request type/status and record status
- Do not touch approval-center files or backend endpoints.

## Data Reuse

Existing client-side data already available in `AttendanceView.vue`:

- `requestReport` from `/api/attendance/reports/requests`
- `records` from `/api/attendance/records`
- `requestReportTotal`
- `requestReportMinutesTotal`
- `formatStatus()`
- `formatRequestType()`
- `exportCsv()`

## UI Slice

### Reports header

Keep the existing total chips, then add a lightweight summary strip with:

- pending requests
- approved requests
- approved minutes
- follow-up records on the current page

### Request report table

Add local filters:

- request type
- request status

These only reshape the currently loaded aggregated rows.

### Records table

Add a local record-status filter to help operators focus on late / adjusted / exception rows without changing pagination or API query parameters.

## Implementation Notes

- Move pure derivation logic into `apps/web/src/views/attendance/useAttendanceReportSurface.ts`.
- Keep `AttendanceView.vue` responsible only for wiring refs/computed values into the existing reports surface.
- Add focused unit coverage for the derivation helper instead of mounting the full attendance page.
