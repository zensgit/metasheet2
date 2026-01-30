# Attendance Policy Template Update - Development Report (2026-01-30)

## Summary
Implemented derived policy fields (entry/resign vs workDate) and expanded the attendance rule-set template to include holiday, role-based, and special-shift policies.

## Changes
- Added derived boolean fields for policy evaluation:
  - `entry_after_work_date`, `entry_on_or_before_work_date`
  - `resign_on_or_before_work_date`, `resign_before_work_date`
- Extended `/api/attendance/rule-sets/template` policy defaults with:
  - Holiday entry/resign zeroing rules
  - Holiday default 8h rule
  - Single-rest workshop trip overtime
  - Security/driver role overtime rules
  - Special user fixed hours rule
- Mapped additional import fields (`UserId`, `workDate`, `entryTime`, `resignTime`) into the template mappings.

## Files Updated
- `plugins/plugin-attendance/index.cjs`
- `docs/ATTENDANCE_IMPORT_DINGTALK_CSV.md`
