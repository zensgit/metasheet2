# Attendance Plugin Development Report (2026-01-20, Extension)

## Scope
- Expand attendance plugin coverage for leave/overtime requests, approval flows, and rotation scheduling.
- Add request report endpoints plus admin CRUD surfaces for new entities.
- Update OpenAPI contracts and frontend admin/report UI.

## Backend Changes
- Added leave/overtime request handling with metadata support and request-type validation in `plugins/plugin-attendance/index.cjs`.
- Added approval flow persistence + step gating; approvals can remain pending until final step.
- Added rotation rules/assignments and rotation-aware shift resolution in work context.
- Added request report endpoint: `GET /api/attendance/reports/requests`.
- Added admin CRUD endpoints:
  - `/api/attendance/leave-types` + `/api/attendance/leave-types/{id}`
  - `/api/attendance/overtime-rules` + `/api/attendance/overtime-rules/{id}`
  - `/api/attendance/approval-flows` + `/api/attendance/approval-flows/{id}`
  - `/api/attendance/rotation-rules` + `/api/attendance/rotation-rules/{id}`
  - `/api/attendance/rotation-assignments` + `/api/attendance/rotation-assignments/{id}`

## Database + Types
- Added migrations:
  - `zzzz20260120110000_add_attendance_request_types.ts`
  - `zzzz20260120111000_create_attendance_leave_types.ts`
  - `zzzz20260120112000_create_attendance_overtime_rules.ts`
  - `zzzz20260120113000_create_attendance_approval_flows.ts`
  - `zzzz20260120114000_create_attendance_rotation_tables.ts`
- Updated `packages/core-backend/src/db/types.ts` with new tables + request type enum.

## OpenAPI Updates
- Extended `AttendanceRequest` enum to include `leave` and `overtime`.
- Added schemas: `AttendanceLeaveType`, `AttendanceOvertimeRule`, `AttendanceApprovalFlow`, `AttendanceRotationRule`, `AttendanceRotationAssignment`, `AttendanceRequestReportItem`.
- Added new paths for reports and admin CRUD in `packages/openapi/src/paths/attendance.yml`.
- Regenerated OpenAPI dist outputs.

## Frontend Updates
- Enhanced `apps/web/src/views/AttendanceView.vue`:
  - Request form supports leave/overtime, duration, and attachments.
  - Request report card added.
  - Admin panels added for leave types, overtime rules, approval flows, rotation rules, and rotation assignments.

## Tests & Scripts
- Updated integration test: `packages/core-backend/tests/integration/attendance-plugin.test.ts`.
- Enhanced UI smoke script: `scripts/verify-attendance-ui.mjs` to cover leave/overtime flows.
- UI smoke runbook: start backend with `JWT_SECRET=dev-secret-key`, generate token via `JWT_SECRET=dev-secret-key node scripts/gen-dev-token.js`, and run with optional `UI_TIMEOUT`, `UI_DEBUG`, `UI_SCREENSHOT_DIR`.
