# Attendance Import Commit Token Persistence (Verification)

Date: 2026-02-07

## Scope
- Commit token persistence + enforcement for attendance import flows.
- Frontend import UI token lifecycle (single-use token refresh).
- E2E smoke via Playwright production flow script.

## Changes Under Test
- DB migration: `packages/core-backend/src/db/migrations/zzzz20260207150000_create_attendance_import_tokens.ts`
- Backend plugin: `plugins/plugin-attendance/index.cjs`
  - No runtime DDL for `attendance_import_tokens`
  - When `ATTENDANCE_IMPORT_REQUIRE_TOKEN=1`:
    - `/api/attendance/import/prepare` fails fast with `503 DB_NOT_READY` if token table missing
    - `/api/attendance/import/preview` + `/api/attendance/import/commit` surface `DB_NOT_READY` for token-table schema issues
    - legacy `/api/attendance/import` also enforces `commitToken` (prevents bypass)
- Frontend UI: `apps/web/src/views/AttendanceView.vue`
  - Always refreshes commit token before Preview/Import (token is single-use)
  - Removes legacy-import fallback on token errors (keeps legacy fallback only for 404)
- E2E: `scripts/verify-attendance-production-flow.mjs`
  - Enforces usage of `/api/attendance/import/commit` by default
  - Produces reproducible screenshots under `output/playwright/...`

## Local Verification

### Backend build
Command:
```bash
pnpm --filter @metasheet/core-backend build
```
Result: PASS

### Backend integration test (attendance)
Command:
```bash
pnpm --filter @metasheet/core-backend test:integration:attendance
```
Result: PASS

### Frontend build
Command:
```bash
pnpm --filter @metasheet/web build
```
Result: PASS (chunk-size warnings only)

### Frontend unit tests
Command:
```bash
pnpm --filter @metasheet/web exec vitest run --watch=false
```
Result: PASS

## Remote E2E Smoke (Pre-deploy Baseline)

Command (example):
```bash
WEB_URL="http://142.171.239.56:8081/attendance" \
AUTH_TOKEN="(redacted)" \
OUTPUT_DIR="output/playwright/attendance-production-flow-remote-20260207" \
node scripts/verify-attendance-production-flow.mjs
```

Result: PASS (full flow completed)

Observed:
- One `COMMIT_TOKEN_INVALID` warning occurred before a successful commit.
  - This is consistent with the old UI reusing a single-use token (preview consumes it).
  - The UI change in this PR refreshes token per Preview/Import, so this warning is expected to disappear after deploy.

Artifacts:
- `output/playwright/attendance-production-flow-remote-20260207/01-overview-loaded.png`
- `output/playwright/attendance-production-flow-remote-20260207/02-overview-after-request.png`
- `output/playwright/attendance-production-flow-remote-20260207/03-admin-loaded.png`
- `output/playwright/attendance-production-flow-remote-20260207/04-import-preview.png`
- `output/playwright/attendance-production-flow-remote-20260207/05-import-batches.png`
- `output/playwright/attendance-production-flow-remote-20260207/06-overview-after-import.png`

## Post-deploy Acceptance Criteria (Production-Ready Gate)
1. Migrations applied (token table exists).
2. Playwright production flow passes.
3. No legacy `/api/attendance/import` usage in the flow.
4. No `COMMIT_TOKEN_INVALID` warning in the flow.

