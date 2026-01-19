# Attendance Plugin Design (Dev)

## Goal
Provide an optional attendance module via the plugin microkernel, covering punches, records, summaries, adjustments, and scheduling with org-aware data handling.

## Architecture
- Plugin package: `plugins/plugin-attendance` registers routes at runtime via the plugin loader.
- Core integration: HTTP routes use the core API router; events emit through the event bus (`attendance.*`).
- RBAC: permissions checked per route (`attendance:read|write|approve|admin`); dev bypass via `RBAC_BYPASS=true`.
- Org scoping: `org_id` inferred from request payload/query/token or defaults to the system org.

## Data Model
- `attendance_rules` (org defaults, working days, grace/rounding)
- `attendance_events` (raw check-in/out events)
- `attendance_records` (daily rollups, status, minutes, workday flag)
- `attendance_requests` + `approval_instances` (adjustments + approvals)
- `attendance_shifts` (schedule templates)
- `attendance_shift_assignments` (user ↔ shift mapping)
- `attendance_holidays` (org calendar)

## API Surface (Selected)
- Punches: `POST /api/attendance/punch`
- Records/Summary: `GET /api/attendance/records`, `GET /api/attendance/summary`
- Adjustments: `POST /api/attendance/requests`, `POST /api/attendance/requests/:id/approve|reject`
- Rules/Settings: `GET|PUT /api/attendance/rules/default`, `GET|PUT /api/attendance/settings`
- Scheduling: `GET|POST|PUT|DELETE /api/attendance/shifts`, `.../assignments`, `.../holidays`
- Export: `GET /api/attendance/export`

## UI Surface
- View: `apps/web/src/views/AttendanceView.vue`, route `/attendance`.
- Sections: punches, date filters, summary, calendar, adjustments, admin console (rules/settings/shifts/assignments/holidays).
- Gated by plugin status; shows empty state when plugin inactive.

## Dev/Ops Notes
- Migrations required before first use: attendance tables + RBAC permissions.
- For dev smoke without DB-seeded permissions: start backend with `RBAC_BYPASS=true`.
- Frontend uses `VITE_API_URL` / `VITE_API_BASE` for API origin.
