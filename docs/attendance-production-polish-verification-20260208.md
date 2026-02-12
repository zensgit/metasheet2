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

GA daily verification reference:

- `docs/attendance-production-ga-daily-gates-20260209.md`

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

For "stability PASS" (strict gates twice consecutively) with evidence folders:

```bash
REQUIRE_ATTENDANCE_ADMIN_API="true" \
REQUIRE_IDEMPOTENCY="true" \
REQUIRE_IMPORT_EXPORT="true" \
API_BASE="http://<HOST>:<PORT>/api" \
AUTH_TOKEN="<ADMIN_JWT>" \
EXPECT_PRODUCT_MODE="attendance" \
PROVISION_USER_ID="<TARGET_USER_UUID_FOR_PROVISIONING_GATE>" \
scripts/ops/attendance-run-strict-gates-twice.sh
```

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
  - Latest evidence (2026-02-09): `output/playwright/attendance-prod-acceptance/20260209-163619/`
  - Latest evidence (2026-02-09): `output/playwright/attendance-prod-acceptance/20260209-164032/`

Post-merge strict gates (2026-02-10): two consecutive strict gate runs passed (including Gate 3 provisioning):

- Evidence:
  - `output/playwright/attendance-prod-acceptance/20260210-145747-1/`
  - `output/playwright/attendance-prod-acceptance/20260210-145747-2/`

Playwright production-flow rate limiting resilience (2026-02-10):

- `scripts/verify-attendance-production-flow.mjs` now retries import commit when the API returns `HTTP 429 RATE_LIMITED` (bounded attempts).
- Verification run: `PASS`
  - Evidence: `output/playwright/attendance-prod-acceptance/20260210-production-flow-rate-limit-retry/`

Provisioning reliability note:

- `scripts/ops/attendance-provision-user.sh` performs a best-effort `POST /api/auth/refresh-token` before calling `POST /api/permissions/grant`.
  - This prevents flakiness when the environment rotates JWT secrets (a previously issued JWT can become invalid).
  - Additional strict runs (2026-02-09): two more consecutive strict gate runs passed (provisioning logs captured under the first run directory).
  - Evidence: `output/playwright/attendance-prod-acceptance/20260209-123959/`
  - Evidence: `output/playwright/attendance-prod-acceptance/20260209-124300/`
- Historical (pre-deploy remote image): idempotency retry required a commitToken.
  - Evidence: `output/playwright/attendance-prod-acceptance/20260208-152606/gate-api-smoke.log`

Artifacts (example):
- `output/playwright/attendance-prod-acceptance/*`

## Execution Record (2026-02-11)

Next-phase development verification (local dev environment) passed:

- Strict gates twice:
  - Gate 2 API smoke: PASS
  - Gate 3 provisioning: PASS
  - Gate 4/5/6 Playwright (production/desktop/mobile): PASS
  - Strict flags enabled:
    - `REQUIRE_ATTENDANCE_ADMIN_API=true`
    - `REQUIRE_IDEMPOTENCY=true`
    - `REQUIRE_IMPORT_EXPORT=true`
    - `REQUIRE_IMPORT_ASYNC=true`
  - Evidence:
    - `output/playwright/attendance-prod-acceptance/20260211-052354-1/`
    - `output/playwright/attendance-prod-acceptance/20260211-052354-2/`

- Backend integration tests:
  - `packages/core-backend/tests/integration/attendance-plugin.test.ts` PASS (5 tests)
  - Includes regression coverage for:
    - import idempotency retry without commitToken
    - async import commit + job polling
    - attendance admin audit logs CSV export
  - Evidence:
    - `output/playwright/attendance-next-phase/20260211-052522/attendance-integration.log`

- Auth + perf hardening:
  - `packages/core-backend/src/auth/AuthService.ts`
    - token verification/refresh now accepts `userId` + legacy `id`/`sub` claims
  - `packages/core-backend/tests/unit/AuthService.test.ts`
    - unit tests PASS (legacy `id` claim coverage for `verifyToken` and `refreshToken`)
  - `scripts/ops/attendance-import-perf.mjs`
    - supports threshold assertions via `MAX_PREVIEW_MS`, `MAX_COMMIT_MS`, `MAX_EXPORT_MS`, `MAX_ROLLBACK_MS`
  - Verification:
    - strict gates twice with default strictness (`REQUIRE_IMPORT_ASYNC` default true): PASS
      - `output/playwright/attendance-prod-acceptance/20260211-053626-1/`
      - `output/playwright/attendance-prod-acceptance/20260211-053626-2/`
    - perf threshold run: PASS
      - `output/playwright/attendance-import-perf-local/attendance-perf-mlhljnlj-wdmfnl/perf-summary.json`
    - local test logs:
      - `output/playwright/attendance-next-phase/20260211-053920/auth-service-unit.log`
      - `output/playwright/attendance-next-phase/20260211-053920/attendance-integration.log`

## Execution Record (2026-02-11, Remote Re-Validation)

Post-closure remote re-validation passed after transient async polling hardening:

- Code fix:
  - PR [#144](https://github.com/zensgit/metasheet2/pull/144)
  - `scripts/ops/attendance-import-perf.mjs` retries transient job poll errors (`429`, `5xx`) for `GET /api/attendance/import/jobs/:id`.

- Perf baseline (10k, tightened thresholds): `PASS`
  - Run: [Attendance Import Perf Baseline #21912709345](https://github.com/zensgit/metasheet2/actions/runs/21912709345)
  - Evidence:
    - `output/playwright/ga/21912709345/attendance-import-perf-21912709345-1/attendance-perf-mli82mht-ximhdx/perf-summary.json`
  - Result:
    - `previewMs=3013`
    - `commitMs=60742`
    - `exportMs=406`
    - `rollbackMs=129`
    - `regressions=[]`
  - Thresholds in effect:
    - `MAX_PREVIEW_MS=100000`
    - `MAX_COMMIT_MS=150000`
    - `MAX_EXPORT_MS=25000`
    - `MAX_ROLLBACK_MS=8000`

- Strict gates twice (remote): `PASS`
  - Run: [Attendance Strict Gates (Prod) #21912806317](https://github.com/zensgit/metasheet2/actions/runs/21912806317)
  - Evidence:
    - `output/playwright/ga/21912806317/attendance-strict-gates-prod-21912806317-1/20260211-160958-1/`
    - `output/playwright/ga/21912806317/attendance-strict-gates-prod-21912806317-1/20260211-160958-2/`
  - Gate 2 API smoke logs contain:
    - `audit export csv ok`
    - `idempotency ok`
    - `export csv ok`
    - `import async idempotency ok`
  - Production flow includes expected warning:
    - `PUNCH_TOO_SOON` (business rule; gate remains PASS).

- Daily dashboard recovery: `PASS`
  - Run: [Attendance Daily Gate Dashboard #21912958814](https://github.com/zensgit/metasheet2/actions/runs/21912958814)
  - Evidence:
    - `output/playwright/ga/21912958814/attendance-daily-gate-dashboard-21912958814-1/attendance-daily-gate-dashboard.md`
    - `output/playwright/ga/21912958814/attendance-daily-gate-dashboard-21912958814-1/attendance-daily-gate-dashboard.json`
  - Result:
    - `overallStatus=pass`
    - `strictRun=21912806317`
    - `perfRun=21912709345`

## Execution Record (2026-02-11, Main Strict Re-Validation with Batch Resolve Gate)

Post-hotfix verification after PR `#147` (`attendance-admin` batch resolve SQL type fix) completed on `main`:

- Deploy:
  - [Build and Push Docker Images #21914265724](https://github.com/zensgit/metasheet2/actions/runs/21914265724): `SUCCESS`
- Strict gates (twice, remote) with `require_batch_resolve=true`:
  - [Attendance Strict Gates (Prod) #21914381403](https://github.com/zensgit/metasheet2/actions/runs/21914381403): `SUCCESS`
- Evidence:
  - `output/playwright/ga/21914381403/20260211-165320-1/`
  - `output/playwright/ga/21914381403/20260211-165320-2/`
- API smoke assertions (both runs):
  - `batch resolve ok`
  - `audit export csv ok`
  - `idempotency ok`
  - `export csv ok`
  - `import async idempotency ok`
  - `SMOKE PASS`
- Playwright assertions (both runs):
  - production flow complete
  - full-flow desktop complete (`features` from `/api/auth/me`)
  - full-flow mobile complete
- Known expected warning:
  - `PUNCH_TOO_SOON` may appear in production flow and does not fail the gate.

## Execution Record (2026-02-11, Next-Phase 1+2+3 Production Closure)

This cycle verifies the merged next-phase hardening items:

1. Large import preview chunking in Admin Center UI.
2. Operation-level metrics/alerts for attendance API latency and failure reasons.
3. Admin audit summary/filter expansion + batch provisioning affected/unchanged visibility.

Merged and deployed:

- PR: [#149](https://github.com/zensgit/metasheet2/pull/149)
- Build + deploy: [Build and Push Docker Images #21915716951](https://github.com/zensgit/metasheet2/actions/runs/21915716951) (`SUCCESS`)

Strict gate validation:

- Run: [Attendance Strict Gates (Prod) #21916079926](https://github.com/zensgit/metasheet2/actions/runs/21916079926) (`SUCCESS`)
- Inputs include `require_batch_resolve=true`.
- Workflow confirms `✅ Strict gates passed twice`.

Evidence (artifact directories):

- `output/playwright/ga/21916079926/20260211-174121-1/`
- `output/playwright/ga/21916079926/20260211-174121-2/`

Key assertions from `gate-api-smoke.log` in both runs:

- `batch resolve ok`
- `audit export csv ok`
- `audit summary ok`
- `idempotency ok`
- `export csv ok`
- `import async idempotency ok`
- `SMOKE PASS`

Conclusion:

- Next-phase `1+2+3` scope is production-verified and non-regressing.
- Production readiness remains **GO**.

## Execution Record (2026-02-12, Post-Documentation Re-Validation)

After pushing documentation commit `803efa96` to `main`, strict gates were re-run to confirm no regression:

- Run: [Attendance Strict Gates (Prod) #21931280648](https://github.com/zensgit/metasheet2/actions/runs/21931280648) (`SUCCESS`)
- Input includes `require_batch_resolve=true`.
- Workflow confirms `✅ Strict gates passed twice`.

Evidence:

- `output/playwright/ga/21931280648/attendance-strict-gates-prod-21931280648-1/20260212-023217-1/`
- `output/playwright/ga/21931280648/attendance-strict-gates-prod-21931280648-1/20260212-023217-2/`

API smoke assertions (both runs):

- `batch resolve ok`
- `audit export csv ok`
- `audit summary ok`
- `idempotency ok`
- `export csv ok`
- `import async idempotency ok`
- `SMOKE PASS`

Result:

- Production verification remains stable on latest `main`.
