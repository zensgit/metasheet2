# Attendance Template Library - Verification Report

Date: 2026-01-31

## Verification Summary
- ✅ Static verification of updated templates, mappings, and UI integration.
- ⚠️ Runtime verification not executed in this pass (depends on running backend + DB).

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

## Recommended Runtime Checks (Optional)
1. Start backend + frontend.
2. Load Attendance > Rule Sets > Load Template.
3. Verify system templates list includes `加班单核对` and parameters.
4. Confirm `考勤组` mapping appears for both `attendanceGroup` and `attendance_group` in import template.
5. Run import preview and verify driver/security groups are detected by `attendance_group`.
