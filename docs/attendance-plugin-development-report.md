# Attendance Plugin Development Report

Date: 2026-01-10

## Overview
The attendance module has been finalized as an optional plugin with org-aware data handling, admin settings, CSV export, and automated absence scheduling. Auto-absence now respects org membership through a `user_orgs` mapping. Frontend support surfaces org/user filters, admin controls, and export actions only when the plugin is active. OpenAPI contracts and RBAC seed data were updated accordingly.

## Backend + Plugin Changes
- Implemented org-aware attendance routes in `plugins/plugin-attendance/index.cjs` (punch, records, summary, requests, approvals, rules, settings, export).
- Added settings management with caching and scheduled auto-absence processing.
- Added event emissions for punches, requests, resolutions, rule updates, settings updates, absence generation, and export.
- Auto-absence now inserts records only for active users mapped to the org in `user_orgs`.
- Added `org_id` support across attendance tables via migration.
- Updated RBAC seed to include attendance permissions with required `name` field.
- Removed legacy `packages/core-backend/src/routes/attendance.ts`.
- Plugin loader now discovers repo-level `plugins/` when running from `packages/core-backend`.
- Added a minimal `packages/core-backend/plugins/good-plugin/index.js` entrypoint to avoid startup errors.

### New/Updated Endpoints
- `POST /api/attendance/punch`
- `GET /api/attendance/records`
- `GET /api/attendance/summary`
- `POST /api/attendance/requests`
- `GET /api/attendance/requests`
- `POST /api/attendance/requests/:id/approve`
- `POST /api/attendance/requests/:id/reject`
- `GET /api/attendance/rules/default`
- `PUT /api/attendance/rules/default`
- `GET /api/attendance/settings`
- `PUT /api/attendance/settings`
- `GET /api/attendance/export`

## Database Changes
- Added migration `20260110120000_add_attendance_org_id.ts` to introduce `org_id` to attendance tables and update indexes.
- Added migration `zzzz20260110123000_create_user_orgs_table.ts` to track user/org membership for auto-absence.
- Updated Kysely types in `packages/core-backend/src/db/types.ts` to include `org_id` on attendance tables.
- Added `user_orgs` table type to Kysely Database typing.

## Frontend Changes
- `apps/web/src/views/AttendanceView.vue` now includes org/user filters, CSV export, and an admin console for settings and default rule management.
- Attendance navigation is gated on plugin activation (`apps/web/src/App.vue`).
- Added a view registry helper at `apps/web/src/view-registry.ts` for dynamic view tests.
- Updated API utilities to honor `VITE_API_URL` with origin fallback and consistent `Content-Type` header handling.

## OpenAPI Updates
- Added `org_id` fields to attendance schemas and `AttendanceSettings` schema in `packages/openapi/src/base.yml`.
- Added `orgId` parameters to relevant paths and added settings/export paths in `packages/openapi/src/paths/attendance.yml`.

## Plugin Manifest
- Added `events.emit` permission in `plugins/plugin-attendance/plugin.json`.

## Notes / Risks
- Auto-absence depends on `user_orgs` membership; ensure the new migration runs and org mappings are populated for non-default orgs.

## Supporting Updates
- Added `apps/web/src/view-registry.ts` for dynamic view tests.
- Updated `apps/web/src/utils/api.ts` and `apps/web/vite.config.ts` to align with `VITE_API_URL` and base header expectations.
- Fixed RBAC seed data to include `permissions.name` in `packages/core-backend/scripts/seed-rbac.ts`.
- Plugin runtime activation requires the server to load `./plugins` and enable `plugin-attendance`.
- Plugin manifest validation now accepts scoped names; sample manifests were updated to satisfy required capabilities/engine metadata.
- Guarded `plugins/sample-basic/index.js` deactivation against missing plugin context.
- Added explicit `id`/`name` attributes on Attendance form fields to address accessibility console warnings.
- Added `id`/`name` attributes across view-level forms (Calendar, Gallery, Form, Meta Fields, PLM, Univer, Grid) to satisfy a11y form field checks.
- Added matching `label for` bindings across view forms to align with the new field IDs.
- Added `scripts/verify-attendance-ui.mjs` Playwright smoke script and wired `verify:attendance-ui` in `package.json`.
- Added `verify:attendance-ui:optional` and chained it in `verify:smoke` (guarded by `RUN_ATTENDANCE_UI_SMOKE=true`).
- Updated attendance settings save handling to avoid treating empty geo-fence fields as zero values.
- Extended the Playwright smoke flow to set `minPunchIntervalMinutes`, punch check-in/out, export CSV, and restore the prior interval when needed.
