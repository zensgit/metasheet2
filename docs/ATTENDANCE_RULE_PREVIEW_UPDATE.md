# Attendance Rule Preview (Engine) Update

## Overview
Added a Rule Preview (Engine) panel in the Attendance admin UI to simulate a single-day record against the rule engine and show the resulting metrics plus engine diagnostics (applied rules, warnings, reasons).

## What Changed
- New admin section **Rule Preview (Engine)** with inputs for:
  - Rule set, user ID, work date, clock in/out
  - Shift name, attendance group, role tags, department, exception reason
  - Actual/overtime/leave hours
  - Toggle to use the current (unsaved) rule set config as engine input
- Run Preview button that calls `/api/attendance/import/preview` and displays a compact summary + engine diagnostics.
- UI styling for the preview card and result blocks.

## Key Files
- `apps/web/src/views/AttendanceView.vue`
  - New state: `rulePreviewForm`, `rulePreviewResult`, `rulePreviewLoading`
  - Helpers: `buildRulePreviewPayload`, `runRulePreview`
  - UI + CSS for preview panel

## API Notes
The preview uses the attendance import preview endpoint:
- `POST /api/attendance/import/preview`
- Sends a single-row payload with a lightweight mapping:
  - `clockInAt` → `firstInAt`
  - `clockOutAt` → `lastOutAt`
  - `actualHours` → `workHours`
  - `overtimeHours` → `overtimeMinutes`
  - `leaveHours` → `leaveMinutes`
- Optional `engine` override from the current rule set JSON (when enabled).
