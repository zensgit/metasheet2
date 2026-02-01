# Attendance Framework Verification Report (2026-02-01)

## Build
- Frontend build:
  - Command: `pnpm --filter @metasheet/web build`
  - Result: ✅ success (vite build OK)

## Backend Tests
- Targeted attendance integration test:
  - Command: `ATTENDANCE_TEST_DATABASE_URL=postgresql://metasheet:metasheet@localhost:5435/metasheet pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts`
  - Result: ✅ passed
  - Note: BPMN workflow engine logs a DB connection warning when Postgres is unavailable, but the attendance test still passed.

- Full integration suite attempt (unintended scope):
  - Command: `pnpm --filter @metasheet/core-backend test:integration -- attendance-plugin.test.ts`
  - Result: ❌ failed (ran full integration suite; several tests require DB on 5432).
  - Reason: Postgres expected at 127.0.0.1:5432 for non-attendance tests; connection refused.

## UI Acceptance (Playwright)
- Command: `pnpm exec node tmp/attendance-ui-verify.mjs`
- Result: ❌ blocked
- Reason: local DB was unavailable (Docker daemon not running), causing RBAC guard DB errors and no preview rows rendered.

## Rerun Instructions (once DB is available)
1) Ensure Postgres/Redis are running (e.g., docker compose or local services).
2) Start backend:
   - `DATABASE_URL=postgresql://metasheet:metasheet@127.0.0.1:5435/metasheet REDIS_HOST=127.0.0.1 REDIS_PORT=6379 PORT=8900 pnpm --filter @metasheet/core-backend dev`
3) Start frontend:
   - `VITE_API_URL=http://127.0.0.1:8900 pnpm --filter @metasheet/web dev -- --host 127.0.0.1 --port 8899`
4) Run Playwright:
   - `pnpm exec node tmp/attendance-ui-verify.mjs`

## Evidence
- Existing screenshots (from prior successful run):
  - `artifacts/attendance-ui-verify/import-batches.png`
  - `artifacts/attendance-ui-verify/import-item-snapshot.png`
  - `artifacts/attendance-ui-verify/import-item-snapshot.json`
- Please regenerate after DB is restored to capture updated UI columns.

