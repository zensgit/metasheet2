# Plugin Framework Verification Report (2026-01-24)

## Scope
- Plugin-driven navigation and route generation
- Plugin enablement persistence and admin toggle API

## Verification
- Frontend build: `pnpm --filter @metasheet/web build`
  - Result: ✅ Success
  - Note: Vite chunk size warning (unchanged warning category)
- Backend build: `pnpm --filter @metasheet/core-backend build`
  - Result: ✅ Success
- Backend dist runtime: ✅ ESM import fixer applied (full `dist` tree) and package set to ESM
- Remote API smoke check (142.171.239.56:8081)
  - `GET /health`: ✅ 200, `pluginsSummary.active` reports 13
  - `GET /api/plugins`: ✅ 200, `enabled` flag present; calendar/gallery/sample plugins loaded after CommonJS fixes
  - `GET /api/admin/plugins/config`: ✅ 200 with admin token
  - `PUT /api/admin/plugins/config`: ✅ toggled `sample-basic` off/on with SafetyGuard confirmation

## Deployment Notes
- Backend image rebuilt on server from `feat/plm-updates`.
- Created `plugin_kv` table manually (migration runner failed due to a missing historical migration).
- Added placeholder migration so `migrate` can run again.
- Added CommonJS plugin package markers for calendar/gallery/sample-basic to load under ESM.
- BPMN workflow engine initialized without missing-dependency errors.

## Manual Checks Not Run
- Admin UI toggle at `/admin/plugins`
- UI verification that disabled plugins are hidden from navigation

## Follow-ups
- Confirm disabled plugin views are removed from navigation and routes via UI.
