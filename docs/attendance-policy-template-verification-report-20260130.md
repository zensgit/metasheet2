# Attendance Policy Template Update - Verification Report (2026-01-30)

## Verification
- CI/CD: Build + Deploy workflows completed successfully for `feat(attendance): add policy template and derived fields`.
- Initial API check after deploy:
  - `/api/attendance/rule-sets/template` returned legacy policies only (`security` + `holiday-default-8h`).
  - `/api/attendance/import/template` did not expose `UserId/entry_time/resign_time` mappings.
  - Conclusion: running service had not picked up the latest plugin bundle.
- Post-redeploy verification (2026-01-30):
  - Server redeploy via `docker compose pull` + `up -d --force-recreate` completed.
  - `/api/attendance/rule-sets/template` now returns:
    - `userGroups`: `security`, `driver`, `single_rest_workshop`
    - `rules`: `holiday-entry-after-zero`, `holiday-resigned-zero`, `holiday-default-8h`,
      `single-rest-trip-overtime`, `security-base-hours`, `security-holiday-overtime`,
      `driver-rest-overtime`, `special-user-fixed-hours`
  - `/api/attendance/import/template` mappings now include:
    - `attendance_group -> attendanceGroup`
    - `UserId -> userId`
    - `workDate -> workDate`
    - `entry_time -> entryTime`
    - `resign_time -> resignTime`
- Import preview (CSV rows, 2025-12-01..2025-12-03):
  - Source: `/Users/huazhou/Downloads/浙江亚光科技股份有限公司_每日汇总（新）_20251201-20251231(2) (1).csv`
  - Rows previewed: 1158
  - Status distribution:
    - `early_leave`: 924
    - `absent`: 132
    - `normal`: 43
    - `adjusted`: 39
    - `partial`: 20
  - Sample item confirms `firstInAt/lastOutAt` parsed (e.g. `07:54` → `2025-12-01T07:54:00.000Z`).
  - Applied policies: 0 (no matching `attendance_group` for `security/driver/单休车间` in this subset).

## Notes
- Derived policy fields are applied during import preview/import; no DB mutation required for evaluation.
- The forced container recreate was required for the backend to pick up the new plugin bundle.
