# Attendance Rule Set Template UI Verification

Date: 2026-01-29

## Environment
- Web: http://142.171.239.56:8081
- API Base: http://142.171.239.56:8081/api

## API Checks
- `GET /api/plugins` → `plugin-attendance` status `active` (all plugins active).
- `GET /api/attendance/rule-sets` → default rule set includes `engine.templates` with `category`/`editable`, and `用户自定义` template present.

## UI Checks
- Opened Attendance page: `http://142.171.239.56:8081/attendance`.
- Clicked **Load template** in Rule Sets section.
- Verified sections:
  - **System templates** shows: `单休车间规则`, `通用提醒`, `角色规则`, `部门提醒` (each with rule counts).
  - **Custom templates** shows: `用户自定义` (Rules: 0).
- Hint displayed: "System templates are locked. You can add or modify custom templates in engine.templates."

## Result
- PASS: System vs Custom template grouping visible in UI.
- PASS: API returns templates with expected metadata.
