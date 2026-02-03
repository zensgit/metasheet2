# Attendance Engine Verification Report

Date: 2026-02-02

## Environment
- Service: `metasheet-backend` (Docker)
- Plugin: `plugin-attendance`

## Checks Performed
- Backend logs show `Attendance plugin activated` and all attendance routes registered.
- API smoke checks:
  - `GET /api/plugins` -> `plugin-attendance` active.
  - `GET /api/attendance/integrations` -> `ok` with empty list.
  - `GET /api/attendance/rule-templates` -> returns system templates (driver/security/etc).
  - `PUT /api/attendance/rule-templates` -> org template library saved (12 templates).
  - `GET /api/attendance/rule-sets/template` -> includes CSV mappings for 部门/职位/异常原因/审批单等字段.
- CSV preview (driver-only filter):
  - Rows: 31
  - Status counts: off 9; early_leave 22.
  - Top rules: driver-default-8h 22.
- CSV preview (security-only filter):
  - Rows: 248
  - Status counts: off 72; early_leave 170; absent 3; partial 2; normal 1.
  - Top rules: security-default-8h 248.
- CSV preview (full):
  - Rows: 11,966
  - Status counts: off 3,474; early_leave 6,770; absent 1,262; late_early 20; normal 244; partial 146; adjusted 49; late 1.
- CSV preview (full, after tightening “missing-overtime-late-clockout” org template):
  - Rows: 11,966
  - Top rules: trip-under-8h 317; security-default-8h 248; leave-but-punched 50; single-rest-trip-overtime 31; overtime-approval-no-punch 30; trip-overtime-conflict 30; driver-default-8h 22.
- CSV preview (full, after tightening “trip-under-8h” org template):
  - Top rules: trip-under-8h 297; security-default-8h 248; leave-but-punched 50; single-rest-trip-overtime 31; overtime-approval-no-punch 30; trip-overtime-conflict 30; driver-default-8h 22.
- UI smoke (Playwright):
  - Attendance page loads; Summary/Admin/Import/Payroll sections visible.
  - No `Missing Bearer token` or `Attendance module not enabled` banners.

## Result
- Plugin loads successfully and core attendance endpoints respond as expected.
