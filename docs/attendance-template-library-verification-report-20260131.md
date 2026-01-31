# Attendance Template Library - Verification Report

Date: 2026-01-31

## Verification Summary
- ✅ Static verification of updated templates, mappings, and UI integration.
- ✅ Runtime verification executed via local backend API (template + import mapping checks).

## Static Checks
- `plugins/plugin-attendance/engine/template-library.cjs`
  - Template definitions load and export `DEFAULT_TEMPLATES`.
- `plugins/plugin-attendance/engine/sample-config.cjs`
  - Uses `DEFAULT_TEMPLATES` (no duplicate template definitions).
- `plugins/plugin-attendance/index.cjs`
  - `/api/attendance/rule-sets/template` now returns `DEFAULT_TEMPLATES`.
  - Rule‑set mapping includes `attendance_group` and `attendanceGroup` targets.
  - Policy userGroups can match either `attendance_group` or `attendanceGroup`.
  - Import template mapping includes `attendance_group`.
- `apps/web/src/views/AttendanceView.vue`
  - `SYSTEM_TEMPLATE_NAMES` includes `加班单核对`.

## Runtime Checks Performed (Local Backend)
- Backend: `pnpm --filter @metasheet/core-backend dev` (local Postgres + Redis).
- Auth: `POST /api/auth/login` with `admin.local@metasheet.app`.
- `GET /api/attendance/rule-sets/template`
  - `engine.templates` length = 9
  - Names include: `单休车间规则`, `通用提醒`, `标准上下班提醒`, `缺卡补卡核对`, `休息日加班`, `角色规则`, `部门提醒`, `加班单核对`, `用户自定义`.
- `GET /api/attendance/import/template`
  - `attendance_group` mapping present for both `attendanceGroup` and `attendance_group` targets.
- Import preview (CSV):
  - Source: `浙江亚光科技股份有限公司_每日汇总（新）_20251201-20251231(2) (1).csv`
  - Driver/Security subset: 279 rows
    - userGroups: `security` = 248, `driver` = 31
  - Sample 100 rows: userGroups `single_rest_workshop` = 31
  - Note: policy rules apply only when `ruleSetId` is provided (preview uses a temporary rule set created from template).

## Remaining Optional UI Checks
1. Start frontend (`pnpm dev`) and load Attendance UI.
2. Load rule‑set template in UI; confirm system templates list and parameter editor.
3. Run import preview with CSV to confirm userGroup detection from `attendance_group`.
