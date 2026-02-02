# Attendance Framework Verification Report (2026-02-01)

## Build
- Frontend build:
  - Command: `pnpm --filter @metasheet/web build`
  - Result: ✅ success (vite build OK)

## Migrations
- Command: `DATABASE_URL=postgresql://metasheet:metasheet@localhost:5435/metasheet pnpm --filter @metasheet/core-backend migrate`
- Result: ✅ applied `zzzz20260202090000_create_attendance_template_library`

## Backend Tests
- Targeted attendance integration test:
  - Command: `DATABASE_URL=postgresql://metasheet:metasheet@localhost:5435/metasheet ATTENDANCE_TEST_DATABASE_URL=postgresql://metasheet:metasheet@localhost:5435/metasheet_test pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts`
  - Result: ✅ passed

## UI Acceptance (Playwright)
- Command: `pnpm exec node scripts/attendance-ui-verify.mjs`
- Result: ✅ passed
- Notes:
  - Preview rows rendered after import.
  - Batch snapshot JSON captured.
  - Environment: backend on 8900 + frontend on 8899 (local dev, `VITE_API_URL` set).

## Re-run Instructions (optional)
1) Ensure Postgres/Redis are running (e.g., docker compose or local services).
2) Start backend:
   - `DATABASE_URL=postgresql://metasheet:metasheet@127.0.0.1:5435/metasheet REDIS_HOST=127.0.0.1 REDIS_PORT=6379 PORT=8900 pnpm --filter @metasheet/core-backend dev`
3) Start frontend:
   - `VITE_API_URL=http://127.0.0.1:8900 pnpm dev`
4) Run Playwright:
   - `pnpm exec node scripts/attendance-ui-verify.mjs`

## Evidence
- Artifacts captured:
  - `artifacts/attendance-ui-verify/import-batches.png`
  - `artifacts/attendance-ui-verify/import-item-snapshot.png`
  - `artifacts/attendance-ui-verify/import-item-snapshot.json`
