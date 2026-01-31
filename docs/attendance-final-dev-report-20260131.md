# Attendance Framework - Final Development Report (2026-01-31)

## Scope
- Attendance policy template, import mapping extensions, driver/security group matching, and upload limit stabilization.

## Key Changes
1) Policy template + derived fields
- Added derived date fields for policy evaluation: `entry_after_work_date`, `entry_on_or_before_work_date`, `resign_on_or_before_work_date`, `resign_before_work_date`.
- Expanded policy templates: `single_rest_workshop`, `security`, `driver`, and `special-user-fixed-hours`.

2) Group matching updates
- `security` group now matches by `attendance_group` = `保安`.
- `driver` group now matches by role contains `司机` (CSV uses position for driver).

3) Import mapping and CSV helper
- Import template now exposes `UserId`, `workDate`, `entry_time`, `resign_time`, `attendance_group` mappings.
- CSV helper auto-detects headers, normalizes dates, supports `UserId`, `entry/resign` fields, and attendance group.

4) Ops stabilization (large preview payload)
- Added `client_max_body_size 50m` to Nginx config.
- Mounted Nginx config into web container to prevent 413 during large preview payloads.

## Implementation Notes
- Policies are applied during preview/import; no DB mutation required for policy evaluation.
- Nginx config is now mounted via `docker-compose.app.yml` for production deployments.

## Commits (main)
- `feat(attendance): match security/driver by attendance_group`
- `feat(attendance): match driver by role`
- `feat(ops): raise nginx upload limit for web`
- Multiple documentation verification commits (see verification report).

## Files Updated
- `plugins/plugin-attendance/index.cjs`
- `scripts/attendance/dingtalk-csv-to-import.mjs`
- `docker/nginx.conf`
- `docker-compose.app.yml`
- `docs/attendance-policy-template-verification-report-20260130.md`
- `docs/attendance-upload-limit-verification-report-20260131.md`

