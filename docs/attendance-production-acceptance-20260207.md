# Attendance Production Acceptance (2026-02-07)

This report defines the acceptance steps and expected evidence for production readiness of the Attendance plugin.

## Environment

- Web: `http://142.171.239.56:8081/attendance`
- API: `http://142.171.239.56:8081/api`

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
