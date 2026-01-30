# Attendance Rule Templates Dev Report

Date: 2026-01-30

## Scope
- Expand built-in attendance rule templates with parameter metadata.
- Enable parameterized cloning of system templates into editable custom templates.
- Add import reconcile tooling to compare `entries` vs `rows` preview output.

## Key Changes
- **Backend template library** (`plugins/plugin-attendance/index.cjs`)
  - Added new system templates: `标准上下班提醒`, `缺卡补卡核对`, `休息日加班`.
  - Added `params` metadata with `paths` bindings so UI can apply parameter values.
  - Preserved default template behavior while allowing parameter overrides.

- **Frontend admin tooling** (`apps/web/src/views/AttendanceView.vue`)
  - Added system template selection + parameter panel.
  - Added “Create custom template” action to clone system templates with parameters applied.
  - Added “Import Reconcile” section to diff `entries` vs `rows` preview results.
  - Added template params export/import (JSON + file) and reconcile export (CSV/JSON with summary rows).

## Files Touched
- `plugins/plugin-attendance/index.cjs`
- `apps/web/src/views/AttendanceView.vue`

## Notes
- Parameterization is applied client-side when creating a custom template; system templates remain locked and keep defaults.
- Reconcile tool relies on `/api/attendance/import/preview` for both payloads and compares metrics per `userId + workDate`.
