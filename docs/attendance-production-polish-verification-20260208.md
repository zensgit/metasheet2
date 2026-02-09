# Attendance Production Polish (Verification)

Date: 2026-02-08

This document verifies the "production polish" deliverables:

1. Admin UX: user search + access panel (roles/permissions).
2. Import reliability: dedup + idempotency + anomalies persistence + CSV export.
3. Access control: attendance role templates assign/unassign.
4. Ops/verification: smoke + Playwright scripts auto-refresh JWT.

## Environments

Example (remote):
- Web: `http://<HOST>:<PORT>/attendance`
- API: `http://<HOST>:<PORT>/api`

## Pre-req: Migrations Applied

Required migrations for this iteration:
- RBAC core (roles/permissions/assignments):
  - `packages/core-backend/src/db/migrations/20250924190000_create_rbac_tables.ts`
- Import commit-token persistence (when `ATTENDANCE_IMPORT_REQUIRE_TOKEN=1`):
  - `packages/core-backend/src/db/migrations/zzzz20260207150000_create_attendance_import_tokens.ts`
- Import commit idempotency (recommended):
  - `packages/core-backend/src/db/migrations/zzzz20260208120000_add_attendance_import_idempotency_key.ts`
  - Note: idempotency retries also work without this column by falling back to `attendance_import_batches.meta.idempotencyKey`, but the migration adds uniqueness + faster lookup.

If running via docker compose (production):
```bash
docker compose -f docker-compose.app.yml exec -T backend \
  node packages/core-backend/dist/src/db/migrate.js
```

## Gate 1: Preflight

Command:
```bash
scripts/ops/attendance-preflight.sh
```

Expected:
- PASS (exit code 0)
- DB/Redis not publicly exposed
- `ATTENDANCE_IMPORT_REQUIRE_TOKEN=1` enforced for production import safety

## Gate 2: API Smoke

Command:
```bash
API_BASE="http://<HOST>:<PORT>/api" \
AUTH_TOKEN="<ADMIN_JWT>" \
EXPECT_PRODUCT_MODE="attendance" \
scripts/ops/attendance-smoke-api.sh
```

Expected:
- PASS
- Validates:
  - `/api/auth/me` + `features.attendance=true`
  - attendance plugin active
  - import prepare/preview/commit works
  - group auto-create + membership
  - request create + approve

Optional strictness (recommended after deploying the polish build):
```bash
REQUIRE_ATTENDANCE_ADMIN_API="true" \
REQUIRE_IDEMPOTENCY="true" \
REQUIRE_IMPORT_EXPORT="true" \
API_BASE="http://<HOST>:<PORT>/api" \
AUTH_TOKEN="<ADMIN_JWT>" \
EXPECT_PRODUCT_MODE="attendance" \
scripts/ops/attendance-smoke-api.sh
```

Note:
- The smoke script calls `/api/auth/refresh-token` first (best-effort) to reduce expired-token flakiness.

## Gate 3: Permission Provisioning (Role Bundles)

### Option A: UI
Path:
- `Attendance -> Admin Center -> User Access`

Checks:
- Search a user by email/name/id
- Load user access summary (roles + permissions)
- Assign/unassign role templates:
  - employee / approver / admin

### Option B: Script
Command:
```bash
API_BASE="http://<HOST>:<PORT>/api" \
AUTH_TOKEN="<ADMIN_JWT>" \
USER_ID="<TARGET_USER_UUID>" \
ROLE="employee" \
scripts/ops/attendance-provision-user.sh
```

Expected:
- PASS (curl succeeds for all permission grants)

## Gate 4: Playwright End-to-End

### 4.1 Desktop admin flow
Command:
```bash
AUTH_TOKEN="<ADMIN_JWT>" \
WEB_URL="http://<HOST>:<PORT>/attendance" \
API_BASE="http://<HOST>:<PORT>/api" \
OUTPUT_DIR="output/playwright/attendance-prod-acceptance/desktop-admin-latest" \
HEADLESS="true" \
node scripts/verify-attendance-production-flow.mjs
```

Expected:
- PASS
- Evidence under `output/playwright/attendance-prod-acceptance/desktop-admin-latest/`

### 4.2 Attendance-focused shell (desktop + mobile)
Desktop:
```bash
AUTH_TOKEN="<ADMIN_JWT>" \
WEB_URL="http://<HOST>:<PORT>/attendance" \
API_BASE="http://<HOST>:<PORT>/api" \
EXPECT_PRODUCT_MODE="attendance" \
OUTPUT_DIR="output/playwright/attendance-prod-acceptance/focused-desktop-latest" \
HEADLESS="true" \
node scripts/verify-attendance-full-flow.mjs
```

Mobile:
```bash
AUTH_TOKEN="<ADMIN_JWT>" \
WEB_URL="http://<HOST>:<PORT>/attendance" \
API_BASE="http://<HOST>:<PORT>/api" \
EXPECT_PRODUCT_MODE="attendance" \
OUTPUT_DIR="output/playwright/attendance-prod-acceptance/focused-mobile-latest" \
HEADLESS="true" \
UI_MOBILE="true" \
node scripts/verify-attendance-full-flow.mjs
```

Expected:
- Desktop PASS
- Mobile PASS and shows "Desktop recommended" gate for Admin Center / Workflow Designer

Note:
- Desktop flow may log `PUNCH_TOO_SOON` when the two Playwright runs happen within the configured minimum punch interval; this is an expected business guard and is treated as best-effort by scripts.

## Import-Specific Acceptance (Manual Spot Checks)

### A) Preview flags duplicate rows
1. Use the import UI to set a payload that contains two rows with the same `(userId, workDate)`.
2. Click `Preview`.

Expected:
- Duplicate row appears in preview as invalid with warning:
  - `Duplicate row for same user/workDate (skipped during commit).`

### B) Commit persists anomalies and supports export
1. Click `Import` (commit).
2. Open `Import Batches`.
3. Click:
  - `Export items CSV`
  - `Export anomalies CSV`

Expected:
- items CSV includes all rows (imported + skipped)
- anomalies CSV includes only rows that were skipped/invalid or contain warnings

### C) Idempotent commit (optional)
1. Send two commits with the same `idempotencyKey`.

Expected:
- second commit returns the existing committed batch (idempotent behavior)
- no duplicate attendance records created

## Execution Record (2026-02-08)

On the remote environment, the following gates were reported as PASS:
- Gate 1: Preflight PASS
- Gate 2: API Smoke PASS
- Gate 3: Permission Provisioning PASS (employee/approver/admin)
- Gate 4: Playwright Desktop PASS
- Gate 4: Playwright Mobile PASS

Strict flags (idempotency + export) should be treated as P0 for production.

Strict gate notes:

- `REQUIRE_IDEMPOTENCY=true` + `REQUIRE_IMPORT_EXPORT=true` now passes after deploying PR `#120`.
  - Evidence: `output/playwright/attendance-prod-acceptance/20260208-162644/`
  - Evidence: `output/playwright/attendance-prod-acceptance/20260208-162845/`
- Follow-up strict run (2026-02-09): two consecutive strict gate runs passed (including Gate 3 provisioning).
  - Note: Gate 1 preflight is host-only and may show as `SKIP` when the gate runner is executed from a workstation without `docker/app.env`.
  - Evidence: `output/playwright/attendance-prod-acceptance/20260209-110635/`
  - Evidence: `output/playwright/attendance-prod-acceptance/20260209-110911/`
  - Additional strict runs (2026-02-09): two more consecutive strict gate runs passed (provisioning logs captured under the first run directory).
  - Evidence: `output/playwright/attendance-prod-acceptance/20260209-123959/`
  - Evidence: `output/playwright/attendance-prod-acceptance/20260209-124300/`
- Historical (pre-deploy remote image): idempotency retry required a commitToken.
  - Evidence: `output/playwright/attendance-prod-acceptance/20260208-152606/gate-api-smoke.log`

Artifacts (example):
- `output/playwright/attendance-prod-acceptance/*`
