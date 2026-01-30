# Attendance Import Template Extension - Development Report (2026-01-30)

## Summary
Expanded the DingTalk CSV import helper and attendance import templates to support real-world CSV headers, userId fields, and entry/resign metadata. Added richer engine context for rule evaluation (userId/role/entry/resign).

## Changes
- CSV import helper:
  - Auto-detects header row (skips report title/time rows).
  - Normalizes `YY-MM-DD` dates and prefers `日期` over numeric `workDate` timestamps.
  - Accepts `UserId/userId`, `部门`, `职位`, `入职时间`, `离职时间` columns.
- Attendance import template:
  - New mappings for `UserId`, `userId`, `workDate`, `entryTime`, `resignTime`.
- Rule engine context:
  - Passes `userId`, `role`, `entryTime`, `resignTime` into engine evaluation for custom/user-specific rules.

## Files Updated
- `scripts/attendance/dingtalk-csv-to-import.mjs`
- `plugins/plugin-attendance/index.cjs`
- `docs/ATTENDANCE_IMPORT_DINGTALK_CSV.md`
- `docs/ATTENDANCE_CUSTOM_RULE_TEMPLATES.md`

## Notes
- These updates keep existing import payloads backward compatible.
