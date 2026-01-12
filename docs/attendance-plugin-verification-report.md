# Attendance Plugin Verification Report

Date: 2026-01-11

## Verification Summary
Completed unit test verification for backend and frontend after adding attendance scheduling (shifts, assignments, holidays). Migration and UI smoke checks were rerun against a clean dev database and succeeded. Follow-up CI fixes were validated with plugin manifest validation plus the plugin loader failure suite.

## Commands Executed
- `pnpm validate:plugins`
- `pnpm --filter @metasheet/core-backend exec vitest run tests/plugin-loader.failures.test.ts`
- `pnpm --filter @metasheet/core-backend exec vitest run src/tests/rate-limiting.test.ts`
- `pnpm --filter @metasheet/core-backend test`
- `pnpm --filter @metasheet/core-backend test:unit`
- `pnpm --filter @metasheet/web exec vitest run --watch=false`
- `pnpm --filter @metasheet/web build`
- `pnpm --filter @metasheet/core-backend migrate`
- `RBAC_BYPASS=true JWT_SECRET=fallback-development-secret-change-in-production PORT=8920 pnpm --filter @metasheet/core-backend dev`
- `VITE_API_URL=http://127.0.0.1:8920 pnpm --filter @metasheet/web dev -- --host 127.0.0.1 --port 8899`
- `JWT_SECRET=fallback-development-secret-change-in-production pnpm --filter @metasheet/core-backend exec tsx scripts/gen-dev-token.ts --user admin --roles admin --perms attendance:read,attendance:write,attendance:approve,attendance:admin --expiresIn 1h`
- `AUTH_TOKEN=<generated> WEB_URL=http://localhost:8902/attendance node scripts/verify-attendance-ui.mjs`

## Results
- Backend full test suite: Passed (`pnpm --filter @metasheet/core-backend test`).
- Rate limiting suite: Passed (`pnpm --filter @metasheet/core-backend exec vitest run src/tests/rate-limiting.test.ts`).
- Backend unit tests: Passed (logs include expected error cases and a warning about sample plugin ESM entry in `tests/unit/server-lifecycle.test.ts`).
- Frontend unit tests: Passed.
- Frontend build: Passed (`pnpm --filter @metasheet/web build`).
- Plugin manifest validation: Passed (warnings only for missing license/wildcard permissions).
- Plugin loader failure suite: Passed.
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
