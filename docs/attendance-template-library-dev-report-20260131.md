# Attendance Template Library - Dev Report

Date: 2026-01-31

## Scope
Step 1→2 of the plan: deliver a reusable **rule template library**, wire it to the rule‑set template endpoint, and improve import mapping compatibility for `attendance_group` fields.

## Changes Implemented
### Backend
- Added **template library** module for attendance rules.
  - File: `plugins/plugin-attendance/engine/template-library.cjs`
  - Exports `SYSTEM_TEMPLATES`, `CUSTOM_TEMPLATES`, `DEFAULT_TEMPLATES`.
- Reused library in sample config.
  - File: `plugins/plugin-attendance/engine/sample-config.cjs`
- Rewired `/api/attendance/rule-sets/template` to serve `DEFAULT_TEMPLATES`.
  - File: `plugins/plugin-attendance/index.cjs`
- Updated rule‑set template mapping to include `attendance_group` targets.
  - File: `plugins/plugin-attendance/index.cjs`
- Added policy group detection for both `attendance_group` and `attendanceGroup`.
  - File: `plugins/plugin-attendance/index.cjs`
- Updated import template mapping to include `attendance_group`.
  - File: `plugins/plugin-attendance/index.cjs`

### Frontend
- Extended system template name whitelist to include `加班单核对`.
  - File: `apps/web/src/views/AttendanceView.vue`

### Documentation
- Added template library guide.
  - File: `docs/attendance-template-library-20260131.md`

## Notes
- Templates now align with key behaviors in the DingTalk rule file while keeping business‑specific rules editable.
- Import preview now supports `attendance_group` mapping for policy rules.
