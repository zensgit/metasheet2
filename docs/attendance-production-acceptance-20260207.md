# Attendance Production Acceptance (2026-02-07)

This report defines the acceptance steps and expected evidence for production readiness of the Attendance plugin.

## Environment

- Web: `http://142.171.239.56:8081/attendance`
- API: `http://142.171.239.56:8081/api`

## GA Daily Gates (Reference)

For GA-level daily verification (strict gates twice + metrics sanity + 10k perf baseline), see:

- `docs/attendance-production-ga-daily-gates-20260209.md`

## One-Command Gate Runner (Recommended)

Run all gates (preflight when available + API smoke + Playwright desktop/mobile) and store artifacts under `output/playwright/`:

```bash
API_BASE="http://142.171.239.56:8081/api" \
AUTH_TOKEN="<ADMIN_JWT>" \
EXPECT_PRODUCT_MODE="attendance" \
scripts/ops/attendance-run-gates.sh
```

Optional strictness (recommended):

```bash
REQUIRE_IDEMPOTENCY="true" \
API_BASE="http://142.171.239.56:8081/api" \
AUTH_TOKEN="<ADMIN_JWT>" \
EXPECT_PRODUCT_MODE="attendance" \
scripts/ops/attendance-run-gates.sh
```

To enforce "stability PASS" (strict gates **twice** consecutively), use:

```bash
API_BASE="http://142.171.239.56:8081/api" \
AUTH_TOKEN="<ADMIN_JWT>" \
EXPECT_PRODUCT_MODE="attendance" \
PROVISION_USER_ID="<TARGET_USER_UUID_FOR_PROVISIONING_GATE>" \
scripts/ops/attendance-run-strict-gates-twice.sh
```

Notes:

- Idempotency retries work even when the DB column `attendance_import_batches.idempotency_key` is not present by falling back to `attendance_import_batches.meta.idempotencyKey`.
- The migration `packages/core-backend/src/db/migrations/zzzz20260208120000_add_attendance_import_idempotency_key.ts` is still recommended for uniqueness + faster lookup.

## Gate 1: Preflight (Must Pass)

Run:

```bash
scripts/ops/attendance-preflight.sh
```

Expected:

- Exit code `0`
- No error about default secrets or DB/Redis public ports

## Gate 2: API Smoke (Must Pass)

Run:

```bash
API_BASE="http://142.171.239.56:8081/api" \
AUTH_TOKEN="<ADMIN_JWT>" \
EXPECT_PRODUCT_MODE="attendance" \
scripts/ops/attendance-smoke-api.sh
```

Expected:

- `SMOKE PASS`
- It validates:
  - `/api/auth/me` features.attendance is true
  - `/api/auth/me` features.mode is `attendance` (when `EXPECT_PRODUCT_MODE=attendance`)
  - plugin-attendance is active
  - import preview + commit works
  - import commit idempotency retry works (when `REQUIRE_IDEMPOTENCY=true`)
  - group auto-create + membership works
  - adjustment requests create + approve works

## Gate 3: Permission Provisioning (Must Pass)

This environment must support creating at least these 3 roles via permissions:

- employee: `attendance:read`, `attendance:write`
- approver: `attendance:read`, `attendance:approve`
- admin: `attendance:read`, `attendance:write`, `attendance:approve`, `attendance:admin`

You can provision permissions either via:

- UI: `Attendance -> Admin Center -> User Access`
- Script: `scripts/ops/attendance-provision-user.sh` (admin token required)

Run (example for employee):

```bash
API_BASE="http://142.171.239.56:8081/api" \
AUTH_TOKEN="<ADMIN_JWT>" \
USER_ID="<TARGET_USER_UUID>" \
ROLE="employee" \
scripts/ops/attendance-provision-user.sh
```

## Gate 3: Playwright End-to-End (Must Pass)

### 3.1 Desktop admin flow (run twice)

```bash
AUTH_TOKEN="<ADMIN_JWT>" \
WEB_URL="http://142.171.239.56:8081/attendance" \
API_BASE="http://142.171.239.56:8081/api" \
OUTPUT_DIR="output/playwright/attendance-prod-acceptance/desktop-admin-1" \
HEADLESS="true" \
node scripts/verify-attendance-production-flow.mjs

AUTH_TOKEN="<ADMIN_JWT>" \
WEB_URL="http://142.171.239.56:8081/attendance" \
API_BASE="http://142.171.239.56:8081/api" \
OUTPUT_DIR="output/playwright/attendance-prod-acceptance/desktop-admin-2" \
HEADLESS="true" \
node scripts/verify-attendance-production-flow.mjs
```

Expected:

- Both runs pass consecutively
- Artifacts exist under `output/playwright/attendance-prod-acceptance/*`

### 3.2 Attendance-focused shell (desktop + mobile)

```bash
AUTH_TOKEN="<ADMIN_JWT>" \
WEB_URL="http://142.171.239.56:8081/attendance" \
API_BASE="http://142.171.239.56:8081/api" \
EXPECT_PRODUCT_MODE="attendance" \
OUTPUT_DIR="output/playwright/attendance-prod-acceptance/focused-desktop" \
HEADLESS="true" \
node scripts/verify-attendance-full-flow.mjs

AUTH_TOKEN="<ADMIN_JWT>" \
WEB_URL="http://142.171.239.56:8081/attendance" \
API_BASE="http://142.171.239.56:8081/api" \
EXPECT_PRODUCT_MODE="attendance" \
OUTPUT_DIR="output/playwright/attendance-prod-acceptance/focused-mobile" \
HEADLESS="true" \
UI_MOBILE="true" \
node scripts/verify-attendance-full-flow.mjs
```

Expected:

- Desktop passes
- Mobile shows desktop-only gating for admin center and can return to overview

## Go / No-Go

Go when:

1. Preflight passes.
2. API smoke passes.
3. Playwright runs pass (desktop admin twice + focused desktop + focused mobile).

## Latest Execution Record (2026-02-07)

This section records the latest successful execution evidence (no secrets included).

- Preflight: `PASS` on `142.171.239.56` (no warnings; `PRODUCT_MODE=attendance`).
- API Smoke: `PASS` (import preview/commit, group auto-create+membership, adjustment request create+approve; `EXPECT_PRODUCT_MODE=attendance`).
- Permission provisioning: `PASS` via `scripts/ops/attendance-provision-user.sh`.
- Playwright:
  - Desktop admin run #1: `PASS`
    - Evidence: `output/playwright/attendance-prod-acceptance/desktop-admin-1/`
  - Desktop admin run #2: `PASS`
    - Note: punch can return `PUNCH_TOO_SOON` (HTTP 429) when runs are too close; script treats it as best-effort.
    - Evidence: `output/playwright/attendance-prod-acceptance/desktop-admin-2/`
  - Desktop admin run #3: `PASS`
    - Evidence: `output/playwright/attendance-prod-acceptance/desktop-admin-3/`
  - Desktop admin run #4: `PASS`
    - Evidence: `output/playwright/attendance-prod-acceptance/desktop-admin-4/`
  - Attendance-focused shell (desktop): `PASS`
    - Evidence: `output/playwright/attendance-prod-acceptance/focused-desktop/`
  - Attendance-focused shell (desktop) rerun: `PASS`
    - Evidence: `output/playwright/attendance-prod-acceptance/focused-desktop-2/`
  - Attendance-focused shell (mobile): `PASS`
    - Evidence: `output/playwright/attendance-prod-acceptance/focused-mobile/`
    - It validates "Desktop recommended" gating for the admin center on mobile.
  - Attendance-focused shell (mobile) rerun: `PASS`
    - Evidence: `output/playwright/attendance-prod-acceptance/focused-mobile-2/`

## Post-Merge Addendum (2026-02-07)

After merging PR `#116` (adds Admin Center -> User Access UI), the following additional acceptance runs passed:

- Desktop admin flow (includes provisioning UI check): `PASS`
  - Evidence: `output/playwright/attendance-prod-acceptance/desktop-admin-permission-ui/`
- Attendance-focused shell (desktop): `PASS`
  - Evidence: `output/playwright/attendance-prod-acceptance/focused-desktop-permission-ui/`
- Attendance-focused shell (mobile): `PASS`
  - Evidence: `output/playwright/attendance-prod-acceptance/focused-mobile-permission-ui/`

## Latest Execution Record (2026-02-08)

This section records a follow-up validation run after additional production-hardening changes:

- API Smoke: `PASS` (`EXPECT_PRODUCT_MODE=attendance`)
- Playwright full flow:
  - Desktop: `PASS`
    - Evidence: `output/playwright/attendance-full-flow-remote-20260208-desktop/`
  - Mobile: `PASS`

## Latest Execution Record (2026-02-09) - Strict Gates (2x consecutive)

Strict gate command (no secrets; token placeholder only):

```bash
REQUIRE_ATTENDANCE_ADMIN_API="true" \
REQUIRE_IDEMPOTENCY="true" \
REQUIRE_IMPORT_EXPORT="true" \
RUN_PREFLIGHT="false" \
API_BASE="http://142.171.239.56:8081/api" \
AUTH_TOKEN="<ADMIN_JWT>" \
EXPECT_PRODUCT_MODE="attendance" \
PROVISION_USER_ID="26979f88-e7cc-4b40-a975-a0353d19aec0" \
scripts/ops/attendance-run-gates.sh
```

Results:

1. Strict run #1: `PASS`
   - Evidence: `output/playwright/attendance-prod-acceptance/20260209-163619/`
   - API smoke log contains:
     - `idempotency ok`
     - `export csv ok`
2. Strict run #2 (consecutive): `PASS`
   - Evidence: `output/playwright/attendance-prod-acceptance/20260209-164032/`
   - API smoke log contains:
     - `idempotency ok`
     - `export csv ok`

Notes:

- Gate 1 (Preflight) is host-only and can show as `SKIP` when running the gate runner from a workstation without `docker/app.env`.
- Provisioning gate is executed when `PROVISION_USER_ID` is set; it provisions role bundles via `POST /api/permissions/grant` (admin token required).
    - Evidence: `output/playwright/attendance-full-flow-remote-20260208-mobile/`

Notes:

- The verifiers refresh JWTs via `POST /api/auth/refresh-token` before running (best-effort).

## Latest Execution Record (2026-02-10) - Strict Gates (GA Workflow)

Strict gates were also executed from GitHub Actions (recommended for ongoing verification):

- Workflow: `Attendance Strict Gates (Prod)`
- Run: [#21856529452](https://github.com/zensgit/metasheet2/actions/runs/21856529452) (`SUCCESS`)
- Artifacts uploaded (14 days):
  - `output/playwright/attendance-prod-acceptance/**`
  - Downloaded evidence (local; extracted from the workflow artifact):
    - `output/playwright/ga/21856529452/20260210-080104-1/`
    - `output/playwright/ga/21856529452/20260210-080104-2/`

Local reproduction (no secrets; token placeholder only):

```bash
REQUIRE_ATTENDANCE_ADMIN_API="true" \
REQUIRE_IDEMPOTENCY="true" \
REQUIRE_IMPORT_EXPORT="true" \
RUN_PREFLIGHT="false" \
API_BASE="http://142.171.239.56:8081/api" \
AUTH_TOKEN="<ADMIN_JWT>" \
EXPECT_PRODUCT_MODE="attendance" \
scripts/ops/attendance-run-strict-gates-twice.sh
```

### Strict Gate Run (REQUIRE_IDEMPOTENCY=true)

If you enable strict flags:

```bash
REQUIRE_ATTENDANCE_ADMIN_API="true" \
REQUIRE_IDEMPOTENCY="true" \
REQUIRE_IMPORT_EXPORT="true" \
API_BASE="http://142.171.239.56:8081/api" \
AUTH_TOKEN="<ADMIN_JWT>" \
EXPECT_PRODUCT_MODE="attendance" \
scripts/ops/attendance-run-gates.sh
```

Expected:
- Gate 2 `API Smoke` passes and logs `idempotency ok` + `export csv ok`.

Execution record (post-deploy PR `#120`, 2026-02-08):
- Strict run #1: `PASS`
  - Evidence: `output/playwright/attendance-prod-acceptance/20260208-162644/`
- Strict run #2 (consecutive): `PASS`
  - Evidence: `output/playwright/attendance-prod-acceptance/20260208-162845/`

Execution record (2026-02-09):
- Strict run #1: `PASS`
  - Note: Gate 1 `Preflight` was `SKIP` because the gate runner was executed from a workstation that does not have `docker/app.env`.
  - Evidence: `output/playwright/attendance-prod-acceptance/20260209-110635/`
  - API smoke log includes `idempotency ok` + `export csv ok`:
    - `output/playwright/attendance-prod-acceptance/20260209-110635/gate-api-smoke.log`
- Strict run #2 (consecutive): `PASS`
  - Evidence: `output/playwright/attendance-prod-acceptance/20260209-110911/`
 - Strict run #3: `PASS`
   - Note: Gate 1 `Preflight` was `SKIP` because the gate runner was executed from a workstation that does not have `docker/app.env`.
   - Evidence: `output/playwright/attendance-prod-acceptance/20260209-123959/`
   - API smoke log includes `idempotency ok` + `export csv ok`:
     - `output/playwright/attendance-prod-acceptance/20260209-123959/gate-api-smoke.log`
   - Provisioning scripts executed (role bundles):
     - `output/playwright/attendance-prod-acceptance/20260209-123959/gate-provision-employee.log`
     - `output/playwright/attendance-prod-acceptance/20260209-123959/gate-provision-approver.log`
     - `output/playwright/attendance-prod-acceptance/20260209-123959/gate-provision-admin.log`
 - Strict run #4 (consecutive): `PASS`
   - Evidence: `output/playwright/attendance-prod-acceptance/20260209-124300/`

Historical (pre-deploy remote image):
- Gate 2 `API Smoke`: `FAIL` (idempotency retry required a commitToken)
  - Evidence: `output/playwright/attendance-prod-acceptance/20260208-152606/gate-api-smoke.log`
  - Evidence: `output/playwright/attendance-prod-acceptance/20260208-162239/gate-api-smoke.log`
