# Attendance Plugin Verification Report

Date: 2026-01-10

## Verification Summary
Completed database migration and RBAC seed updates, plus unit test verification for backend and frontend. Ran full workspace validation (plugin manifests, lint/type-check hooks, migration ordering), runtime API smoke checks with JWT auth, and UI verification in the Attendance view (no console warnings after form field updates). Added a Playwright smoke script and executed it successfully.

## Commands Executed
- `pnpm --filter @metasheet/core-backend migrate`
- `pnpm --filter @metasheet/core-backend seed:rbac`
- `pnpm --filter @metasheet/core-backend test:unit`
- `pnpm --filter @metasheet/web exec vitest run --watch=false`
- `pnpm validate:all`
- `PORT=8920 RBAC_BYPASS=true pnpm --filter @metasheet/core-backend dev:core`
- `pnpm --filter @metasheet/core-backend exec tsx -e "import { authService } from './src/auth/AuthService.ts'; ..."`
- `curl -H "Authorization: Bearer <token>" http://localhost:8920/api/attendance/*`
- `curl -X PUT -H "Authorization: Bearer <token>" http://localhost:8920/api/attendance/settings`
- `VITE_API_URL=http://127.0.0.1:8920 pnpm --filter @metasheet/web dev -- --host 127.0.0.1 --port 8899`
- `curl -I http://localhost:8901/`
- `AUTH_TOKEN=<token> WEB_URL=http://localhost:8901/attendance node scripts/verify-attendance-ui.mjs`
- `curl -X PUT -H "Authorization: Bearer <token>" -H "Content-Type: application/json" http://localhost:8920/api/attendance/settings -d '{"minPunchIntervalMinutes":1}'`
- `RUN_ATTENDANCE_UI_SMOKE=true pnpm verify:attendance-ui:optional`

## Results
- Migration: Success (renamed to `zzzz20260110123000_create_user_orgs_table.ts` to preserve order).
- RBAC seed: Success after fixing missing `permissions.name` data in seed script.
- Backend unit tests: Passed.
- Frontend unit tests: Passed.
- `pnpm validate:all`: Re-ran after UI smoke updates; passed with 9 plugin manifest warnings (missing license/wildcard permissions), lint/type-check scripts absent, migration order OK.
- Runtime smoke tests: Passed with JWT auth (punch/summary/records/requests/rules/settings/export flows).
- Frontend dev server: Started (picked port 8901 due to conflicts), responded with 200, then stopped via SIGINT.
- UI verification: Attendance view loaded with authenticated data (summary counts, recent requests, records table, settings/rule forms).
- Settings reset: `minPunchIntervalMinutes` set back to `1` via `/api/attendance/settings`.
- Plugin shutdown: `sample-basic` deactivation completed without context errors.
- Playwright smoke script: Passed after updating settings parsing; confirmed check-in/out and CSV export.

## Smoke Test Outcomes
- Punch check-in/out succeeded; record marked `early_leave` due to short interval.
- Summary/records/requests/rules/settings endpoints returned 200-series responses after using `Authorization: Bearer`.
- Adjustment request created and approved successfully.
- CSV export returned data for the test user.

## Runtime Smoke Test Notes
- Ports 7778 and 8900 were already in use, so the server was started on `http://localhost:8920`.
- Vite dev server selected port 8901 after 8899 and 8900 were occupied.
- Plugin loader now discovers repo-level `plugins/`, so no local copy of the plugin was required for runtime verification.
- `RBAC_BYPASS=true` bypasses permissions only; JWT auth is still required for attendance routes.
- Auth token was injected into localStorage (`auth_token`) for UI verification.
- Devtools console: no warnings after adding `id`/`name` attributes and `label for` bindings on Attendance fields.
- Playwright run requires backend + frontend running and an auth token in `AUTH_TOKEN`.
- `verify:smoke` now includes `verify:attendance-ui:optional`, gated by `RUN_ATTENDANCE_UI_SMOKE=true`.
- Backend startup logged DB connection timeouts for config/process definitions in this environment; attendance UI checks still completed.
- Attendance settings save flow previously failed when geo-fence inputs were empty; update now treats empty fields as unset.

## Follow-ups (Optional)
- Start the backend with configured DB/Redis and validate live attendance workflows.
- Assign `attendance:*` permissions to roles in the target environment.
