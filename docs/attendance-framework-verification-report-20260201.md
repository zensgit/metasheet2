# Attendance Framework Verification Report (2026-02-01)

## Build
- Frontend build:
  - Command: `pnpm --filter @metasheet/web build`
  - Result: ✅ success (vite build OK)

## Backend Tests
- Targeted attendance integration test:
  - Command: `ATTENDANCE_TEST_DATABASE_URL=postgresql://metasheet:metasheet@localhost:5435/metasheet pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts`
  - Result: ❌ failed
  - Reason: DB auth failed for user `metasheet` during BPMN/EventBus init; test aborted before assertions.
  - Follow-up: verify DB credentials or set the core backend DB env vars to the same Postgres instance used by the attendance tests.

## UI Acceptance (Playwright)
- Command: `pnpm exec node scripts/attendance-ui-verify.mjs`
- Result: ✅ passed
- Notes:
  - Preview rows rendered after import.
  - Batch snapshot JSON captured.

## Re-run Instructions (optional)
1) Ensure Postgres/Redis are running (e.g., docker compose or local services).
2) Start backend:
   - `DATABASE_URL=postgresql://metasheet:metasheet@127.0.0.1:5435/metasheet REDIS_HOST=127.0.0.1 REDIS_PORT=6379 PORT=8900 pnpm --filter @metasheet/core-backend dev`
3) Start frontend:
   - `VITE_API_URL=http://127.0.0.1:8900 pnpm --filter @metasheet/web dev -- --host 127.0.0.1 --port 8899`
4) Run Playwright:
   - `pnpm exec node scripts/attendance-ui-verify.mjs`

## Evidence
- Artifacts captured:
  - `artifacts/attendance-ui-verify/import-batches.png`
  - `artifacts/attendance-ui-verify/import-item-snapshot.png`
  - `artifacts/attendance-ui-verify/import-item-snapshot.json`
