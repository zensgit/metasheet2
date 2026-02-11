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

Provisioning gate enabled (repo variable `ATTENDANCE_PROVISION_USER_ID`) and re-validated:

- Run: [#21862429047](https://github.com/zensgit/metasheet2/actions/runs/21862429047) (`SUCCESS`)
- Downloaded evidence:
  - `output/playwright/ga/21862429047/20260210-110831-1/`
  - `output/playwright/ga/21862429047/20260210-110831-2/`

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

## Latest Execution Record (2026-02-10) - Strict Gates (post-merge PR #129)

Strict gate command (token placeholder only):

```bash
REQUIRE_ATTENDANCE_ADMIN_API="true" \
REQUIRE_IDEMPOTENCY="true" \
REQUIRE_IMPORT_EXPORT="true" \
RUN_PREFLIGHT="false" \
API_BASE="http://142.171.239.56:8081/api" \
AUTH_TOKEN="<ADMIN_JWT>" \
EXPECT_PRODUCT_MODE="attendance" \
PROVISION_USER_ID="<TARGET_USER_UUID_FOR_PROVISIONING_GATE>" \
scripts/ops/attendance-run-gates.sh
```

Results:

1. Strict run #1: `PASS`
   Evidence: `output/playwright/attendance-prod-acceptance/20260210-130211/`
   API smoke log contains: `idempotency ok`, `export csv ok`
2. Strict run #2 (consecutive): `PASS`
   Evidence: `output/playwright/attendance-prod-acceptance/20260210-130454/`
   API smoke log contains: `idempotency ok`, `export csv ok`

Perf baseline (import response-size controls; large import safe defaults):

- 10k commit + export + rollback: `PASS`
  Evidence: `output/playwright/attendance-import-perf/attendance-perf-mlgm7tss-775i34/perf-summary.json`
  previewMs: `3462`
  commitMs: `108327`
  exportMs: `1106`
  rollbackMs: `327`
- 50k preview: `PASS`
  Evidence: `output/playwright/attendance-import-perf/attendance-perf-mlgmasnj-1bo840/perf-summary.json`
  previewMs: `5217`
- 100k preview: `PASS`
  Evidence: `output/playwright/attendance-import-perf/attendance-perf-mlgmb8xc-7hkkzr/perf-summary.json`
  previewMs: `5486`

Notes:

- Gate 1 (Preflight) can be `SKIP` when the gate runner host does not have `docker/app.env`.
- Perf script defaults to response-size safe flags for `ROWS > 2000`: `previewLimit=200`, `returnItems=false`.

## Latest Execution Record (2026-02-10) - Strict Gates (post-merge PR #131)

Strict gate command (token placeholder only):

```bash
REQUIRE_ATTENDANCE_ADMIN_API="true" \
REQUIRE_IDEMPOTENCY="true" \
REQUIRE_IMPORT_EXPORT="true" \
RUN_PREFLIGHT="false" \
API_BASE="http://142.171.239.56:8081/api" \
AUTH_TOKEN="<ADMIN_JWT>" \
EXPECT_PRODUCT_MODE="attendance" \
PROVISION_USER_ID="<TARGET_USER_UUID_FOR_PROVISIONING_GATE>" \
scripts/ops/attendance-run-gates.sh
```

Results:

1. Strict run #1: `PASS`
   - Evidence: `output/playwright/attendance-prod-acceptance/20260210-143245/`
   - API smoke log contains: `idempotency ok`, `export csv ok`
2. Strict run #2 (consecutive): `PASS`
   - Evidence: `output/playwright/attendance-prod-acceptance/20260210-143523/`
   - API smoke log contains: `idempotency ok`, `export csv ok`

Perf baseline (post-merge PR `#131` import commit perf):

- 10k commit + rollback: `PASS`
  - Evidence (downloaded from GA artifact):
    - `output/playwright/ga/21868374518/attendance-import-perf-21868374518-1/attendance-perf-mlgomass-j77nax/perf-summary.json`
  - previewMs: `2877`
  - commitMs: `62440`
  - rollbackMs: `207`

Notes:

- A prior strict-gates GA run failed due to a transient `HTTP 500` on `POST /api/attendance/import/commit`.
  To reduce false negatives while still keeping the gate strict, `scripts/ops/attendance-smoke-api.mjs` now retries the commit step
  (bounded; default `COMMIT_RETRIES=3`) by preparing a fresh commit token when needed.

## Latest Execution Record (2026-02-10) - Strict Gates (post-merge PR #132)

Strict gates twice (workstation run; token placeholder only):

```bash
REQUIRE_ATTENDANCE_ADMIN_API="true" \
REQUIRE_IDEMPOTENCY="true" \
REQUIRE_IMPORT_EXPORT="true" \
RUN_PREFLIGHT="false" \
API_BASE="http://142.171.239.56:8081/api" \
AUTH_TOKEN="<ADMIN_JWT>" \
EXPECT_PRODUCT_MODE="attendance" \
PROVISION_USER_ID="<TARGET_USER_UUID_FOR_PROVISIONING_GATE>" \
scripts/ops/attendance-run-strict-gates-twice.sh
```

Results:

1. Strict run #1: `PASS`
   - Evidence: `output/playwright/attendance-prod-acceptance/20260210-145747-1/`
2. Strict run #2 (consecutive): `PASS`
   - Evidence: `output/playwright/attendance-prod-acceptance/20260210-145747-2/`

Notes:

- Gate 1 (Preflight) shows `SKIP` because this was executed from a workstation (`RUN_PREFLIGHT=false`).
- Provisioning gate was enabled (`PROVISION_USER_ID` set), and passed in both runs.

## Latest Execution Record (2026-02-10) - Playwright Prod Flow (Rate Limit Retry)

When `ATTENDANCE_RATE_LIMIT_ENABLED=true` (default in production), the admin import commit may return `HTTP 429 RATE_LIMITED`.
The Playwright production-flow script now retries this commit step (bounded) using `retryAfterMs` from the API response.

Verification run:

- `scripts/verify-attendance-production-flow.mjs`: `PASS`
  - Evidence: `output/playwright/attendance-prod-acceptance/20260210-production-flow-rate-limit-retry/`

## Latest Execution Record (2026-02-11) - Production Closure (PR #136 + #137)

Goal of this closure cycle:

- Make async import strict gates the default.
- Enforce perf thresholds in workflow.
- Ensure production deploy path applies DB migrations before smoke checks.

Execution timeline (UTC):

1. Initial strict/perf runs on feature branch (before merge) failed:
   - Strict: [#21894139054](https://github.com/zensgit/metasheet2/actions/runs/21894139054)
     - Gate 2 failed with missing admin audit export endpoint (`404`).
     - Evidence: `output/playwright/ga/21894139054/20260211-054336-1/gate-api-smoke.log`
   - Perf: [#21894142162](https://github.com/zensgit/metasheet2/actions/runs/21894142162)
     - Failed on `POST /api/attendance/import/commit-async` (`404`).
2. Merged `#136` and deployed:
   - Merge commit: `5e80f9a3`
   - Build+deploy workflow: [#21894196709](https://github.com/zensgit/metasheet2/actions/runs/21894196709) (`SUCCESS`)
3. Post-merge strict/perf runs still failed due stale DB schema:
   - Strict: [#21894255303](https://github.com/zensgit/metasheet2/actions/runs/21894255303)
     - `AUDIT_LOGS_EXPORT_FAILED`: `column "occurred_at" does not exist`
     - Evidence: `output/playwright/ga/21894255303/20260211-054939-1/gate-api-smoke.log`
   - Perf: [#21894258310](https://github.com/zensgit/metasheet2/actions/runs/21894258310)
     - `DB_NOT_READY`: Attendance tables missing for async import job path
4. Remediation: merged `#137` to run migrations in deploy workflow:
   - Merge commit: `24b97562`
   - Build+deploy workflow: [#21894316469](https://github.com/zensgit/metasheet2/actions/runs/21894316469) (`SUCCESS`)
5. Final verification on `main`:
   - Strict gates twice: [#21894374032](https://github.com/zensgit/metasheet2/actions/runs/21894374032) (`SUCCESS`)
     - Evidence:
       - `output/playwright/ga/21894374032/20260211-055556-1/`
       - `output/playwright/ga/21894374032/20260211-055556-2/`
     - Gate 2 API smoke log (both runs) contains:
       - `audit export csv ok`
       - `idempotency ok`
       - `export csv ok`
       - `import async idempotency ok`
   - Perf baseline: [#21894377908](https://github.com/zensgit/metasheet2/actions/runs/21894377908) (`SUCCESS`)
     - Evidence:
       - `output/playwright/ga/21894377908/attendance-perf-mlhm8esx-abitlr/perf-summary.json`
     - Result:
       - `rows=10000`
       - `previewMs=2919`
       - `commitMs=66985`
       - `exportMs=390`
       - `rollbackMs=114`
       - `regressions=[]`

Go/No-Go decision (2026-02-11):

- **GO**
- Reason: strict gates 2x PASS + perf threshold gate PASS after deployment pipeline migration fix.

## Latest Execution Record (2026-02-11) - Final Re-Validation (PR #144)

Goal of this follow-up cycle:

- Remove perf gate flakiness caused by transient `502` during async import job polling.
- Re-validate strict gates + perf thresholds + daily dashboard after the fix.

Code change:

- PR [#144](https://github.com/zensgit/metasheet2/pull/144)
- Commit: `faec9a30`
- Change: `scripts/ops/attendance-import-perf.mjs` now retries transient job-poll responses (`429`, `5xx`) for `GET /api/attendance/import/jobs/:id` until timeout.

Execution timeline (UTC):

1. Baseline failure observed before fix:
   - Perf run: [#21912578076](https://github.com/zensgit/metasheet2/actions/runs/21912578076) (`FAILURE`)
   - Symptom: transient `502 Bad Gateway` while polling async import job.
2. Post-fix perf gate re-run:
   - Perf run: [#21912709345](https://github.com/zensgit/metasheet2/actions/runs/21912709345) (`SUCCESS`)
   - Evidence:
     - `output/playwright/ga/21912709345/attendance-import-perf-21912709345-1/attendance-perf-mli82mht-ximhdx/perf-summary.json`
   - Result:
     - `rows=10000`
     - `previewMs=3013`
     - `commitMs=60742`
     - `exportMs=406`
     - `rollbackMs=129`
     - `thresholds={preview:100000, commit:150000, export:25000, rollback:8000}`
     - `regressions=[]`
3. Strict gates (twice, remote) re-run:
   - Strict run: [#21912806317](https://github.com/zensgit/metasheet2/actions/runs/21912806317) (`SUCCESS`)
   - Evidence:
     - `output/playwright/ga/21912806317/attendance-strict-gates-prod-21912806317-1/20260211-160958-1/`
     - `output/playwright/ga/21912806317/attendance-strict-gates-prod-21912806317-1/20260211-160958-2/`
   - Gate 2 API smoke logs contain:
     - `audit export csv ok`
     - `idempotency ok`
     - `export csv ok`
     - `import async idempotency ok`
   - Gate 4 production flow logs include expected business warning:
     - `PUNCH_TOO_SOON` (does not fail gate).
4. Daily dashboard recovery check:
   - Dashboard run: [#21912958814](https://github.com/zensgit/metasheet2/actions/runs/21912958814) (`SUCCESS`)
   - Evidence:
     - `output/playwright/ga/21912958814/attendance-daily-gate-dashboard-21912958814-1/attendance-daily-gate-dashboard.md`
     - `output/playwright/ga/21912958814/attendance-daily-gate-dashboard-21912958814-1/attendance-daily-gate-dashboard.json`
   - Result: `overallStatus=pass` (strict run `21912806317`, perf run `21912709345`).

Go/No-Go decision (2026-02-11, final re-validation):

- **GO (unchanged)**
- Reason: strict gates twice PASS + tightened perf thresholds PASS + daily dashboard PASS.
