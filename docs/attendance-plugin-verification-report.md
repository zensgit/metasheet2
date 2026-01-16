# Attendance Plugin Verification Report

Date: 2026-01-11

## Update (2026-01-15)
### Commands Executed
- `docker exec -i metasheet-dev-postgres psql -U metasheet -d postgres -c "DROP DATABASE IF EXISTS metasheet_attendance_verify;"`
- `docker exec -i metasheet-dev-postgres psql -U metasheet -d postgres -c "CREATE DATABASE metasheet_attendance_verify;"`
- `DB_QUERY_TIMEOUT=120000 DB_STATEMENT_TIMEOUT=120000 DATABASE_URL=postgres://metasheet:metasheet@127.0.0.1:5435/metasheet_attendance_verify pnpm --filter @metasheet/core-backend migrate`
- `PORT=8912 RBAC_BYPASS=true DATABASE_URL=postgres://metasheet:metasheet@127.0.0.1:5435/metasheet_attendance_verify pnpm --filter @metasheet/core-backend dev:core`
- `curl http://127.0.0.1:8912/api/auth/dev-token?...`
- `curl -H "Authorization: Bearer <token>" -d '{"eventType":"check_in"}' http://127.0.0.1:8912/api/attendance/punch`
- `curl http://127.0.0.1:8912/api/plugins`
- `DATABASE_URL=postgres://metasheet:metasheet@127.0.0.1:5435/metasheet_attendance_verify pnpm --filter @metasheet/core-backend test:integration:attendance`

### Results
- Migrations succeeded on `metasheet_attendance_verify`.
- First migration attempt hit a query read timeout; rerun with `DB_QUERY_TIMEOUT/DB_STATEMENT_TIMEOUT=120000` succeeded.
- Attendance plugin activated on startup; routes registered successfully.
- `POST /api/attendance/punch` returned `200` with event + record payload.
- `/api/plugins` now returns an array and includes `plugin-attendance` with `status=active`.
- Attendance integration smoke runs via `vitest.integration.config.ts` with `test:integration:attendance`.
- Full `test:integration` still fails in this repo due to existing snapshot-protection and plugin-failure suites (not caused by attendance changes).
- Attendance integration smoke completed with expected BPMN missing-table warnings (workflow tables are not part of the clean DB).

## Update (2026-01-16)
### Commands Executed
- `pnpm install`
- `pnpm --filter @metasheet/core-backend test:integration:attendance`

### Results
- Initial run failed due to missing dependencies; added `lodash` to `@metasheet/core-backend` and reran successfully.
- `test:integration:attendance` passed (1 test); Vite CJS deprecation warning noted in logs.

## Verification Summary
Completed unit test verification for backend and frontend after adding attendance scheduling (shifts, assignments, holidays). Migration and UI smoke checks were rerun against a clean dev database and succeeded.

## Commands Executed
- `pnpm --filter @metasheet/core-backend test:unit`
- `pnpm --filter @metasheet/web exec vitest run --watch=false`
- `pnpm --filter @metasheet/core-backend migrate`
- `RBAC_BYPASS=true JWT_SECRET=fallback-development-secret-change-in-production PORT=8920 pnpm --filter @metasheet/core-backend dev`
- `VITE_API_URL=http://127.0.0.1:8920 pnpm --filter @metasheet/web dev -- --host 127.0.0.1 --port 8899`
- `JWT_SECRET=fallback-development-secret-change-in-production pnpm --filter @metasheet/core-backend exec tsx scripts/gen-dev-token.ts --user admin --roles admin --perms attendance:read,attendance:write,attendance:approve,attendance:admin --expiresIn 1h`
- `AUTH_TOKEN=<generated> WEB_URL=http://localhost:8902/attendance node scripts/verify-attendance-ui.mjs`

## Results
- Backend unit tests: Passed (logs include expected error cases and a warning about sample plugin ESM entry in `tests/unit/server-lifecycle.test.ts`).
- Frontend unit tests: Passed.
- Migration: Passed on clean dev database (`metasheet_attendance`).
- Backend dev server: Started on `http://localhost:8920` with attendance routes registered.
- Frontend dev server: Started on `http://localhost:8902` (8899-8901 in use).
- UI smoke test: Passed (check-in/out + CSV export).

## Smoke Test Outcomes
- Check-in/out and CSV export passed.

## Runtime Smoke Test Notes
- Backend unit logs include expected error traces for negative test cases and a warning about `plugins/sample-basic/index.js` being treated as ESM.
- Migration failure on the original DB indicates a missing historical migration; verification succeeded after using a clean dev DB.

## Follow-ups (Optional)
- Start the backend with configured DB/Redis and validate live attendance workflows.
- Assign `attendance:*` permissions to roles in the target environment.
