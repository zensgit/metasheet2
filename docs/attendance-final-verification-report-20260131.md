# Attendance Framework - Final Verification Report (2026-01-31)

## Environment
- Web: http://142.171.239.56:8081
- API: http://142.171.239.56:8081/api

## Verification Summary
1) Policy template availability
- `/api/attendance/rule-sets/template` returns:
  - `security` → `attendance_group` contains `保安`
  - `driver` → `role` contains `司机`
  - `single_rest_workshop` → `attendance_group` contains `单休车间`

2) Import template mapping
- `/api/attendance/import/template` includes:
  - `attendance_group -> attendanceGroup`
  - `UserId -> userId`
  - `workDate -> workDate`
  - `entry_time -> entryTime`
  - `resign_time -> resignTime`

3) Policy previews
- `security-base-hours` triggered for 保安 rows (preview set).
- `driver-rest-overtime` validated via authorized simulated rest-day punch:
  - user `17224712726141831`, date `2025-12-07`
  - status `off`, warning `司机休息日打卡算加班`

4) Upload limit
- Nginx `client_max_body_size 50m` in web container.
- Large preview payload (1526 rows) succeeded; no 413.

## Cleanup
- Temporary rule sets created for preview were deleted after verification.

