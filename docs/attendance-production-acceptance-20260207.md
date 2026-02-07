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
API_BASE="http://142.171.239.56:8081/api" AUTH_TOKEN="<ADMIN_JWT>" scripts/ops/attendance-smoke-api.sh
```

Expected:

- `SMOKE PASS`
- It validates:
  - `/api/auth/me` features.attendance is true
  - plugin-attendance is active
  - import preview + commit works
  - group auto-create + membership works

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
PRODUCT_MODE="attendance" \
FEATURES_JSON='{"mode":"attendance","attendance":true,"attendanceAdmin":true,"attendanceImport":true,"workflow":false}' \
OUTPUT_DIR="output/playwright/attendance-prod-acceptance/focused-desktop" \
HEADLESS="true" \
node scripts/verify-attendance-full-flow.mjs

AUTH_TOKEN="<ADMIN_JWT>" \
WEB_URL="http://142.171.239.56:8081/attendance" \
PRODUCT_MODE="attendance" \
FEATURES_JSON='{"mode":"attendance","attendance":true,"attendanceAdmin":true,"attendanceImport":true,"workflow":false}' \
OUTPUT_DIR="output/playwright/attendance-prod-acceptance/focused-mobile" \
HEADLESS="true" \
UI_MOBILE="true" \
ALLOW_EMPTY_RECORDS="true" \
node scripts/verify-attendance-full-flow.mjs
```

Expected:

- Desktop passes
- Mobile shows desktop-only gating for admin center (acceptable for this release)

## Go / No-Go

Go when:

1. Preflight passes.
2. API smoke passes.
3. Playwright runs pass (desktop admin twice + focused desktop + focused mobile).

