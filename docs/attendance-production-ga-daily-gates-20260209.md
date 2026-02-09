# Attendance Production GA: Daily Gates (2026-02-09)

This document defines the **daily** (or per-deploy) verification loop for keeping the Attendance plugin production-ready.

Rules:

- Do not write any real `AUTH_TOKEN`/JWT/secret into this repo or any document. Use `<ADMIN_JWT>` placeholders.
- Store evidence only under `output/playwright/` (gitignored).

## Target Environment (Current)

- Web: `http://142.171.239.56:8081/attendance`
- API: `http://142.171.239.56:8081/api`
- Backend metrics (host-local): `http://127.0.0.1:8900/metrics/prom` (not exposed via nginx)

## GA Gates (P0)

### 1) Strict Gates Twice (Stability PASS)

This is the primary Go/No-Go gate.

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

Expected:

- Both runs PASS.
- `gate-api-smoke.log` contains:
  - `idempotency ok`
  - `export csv ok`

Evidence:

- The runner prints two evidence directories under:
  - `output/playwright/attendance-prod-acceptance/*`

### 2) Host Metrics Sanity (Ops-only, on production host)

Run on the production host (where backend binds to `127.0.0.1:8900`):

```bash
scripts/ops/attendance-check-metrics.sh
```

Expected:

- PASS, and the endpoint contains the attendance counters:
  - `attendance_api_errors_total`
  - `attendance_rate_limited_total`

Notes:

- This gate cannot be executed from a workstation because the backend metrics endpoint is not exposed through nginx.
- You can override the target:
  - `METRICS_URL="http://127.0.0.1:8900/metrics/prom" scripts/ops/attendance-check-metrics.sh`

### 3) 10k Import Perf Baseline (Rollback Enabled)

This gate establishes a minimum performance baseline for production v1 while keeping the environment clean.

```bash
API_BASE="http://142.171.239.56:8081/api" \
AUTH_TOKEN="<ADMIN_JWT>" \
ROWS="10000" \
MODE="commit" \
ROLLBACK="true" \
EXPORT_CSV="false" \
node scripts/ops/attendance-import-perf.mjs
```

Expected:

- Preview succeeds and returns items.
- Commit succeeds and returns `batchId`.
- Rollback succeeds (no batch/items left behind).
- Evidence JSON is written to:
  - `output/playwright/attendance-import-perf/<runId>/perf-summary.json`

Recommended thresholds (adjust after 1 week of real traffic data):

- `previewMs <= 120000` for 10k rows
- `commitMs <= 180000` for 10k rows

Notes:

- By default, this script does **not** enable `groupSync` to avoid creating persistent groups/members.
- If you see `504 Gateway Time-out` from nginx on preview/commit, ensure the web proxy timeouts are increased:
  - `docker/nginx.conf`: `proxy_read_timeout 300s` (then redeploy/restart web)
- To also verify export:
  - `EXPORT_CSV="true" EXPORT_TYPE="anomalies" ... node scripts/ops/attendance-import-perf.mjs`

## GitHub Actions (Recommended)

### A) Daily Strict Gates (Prod)

Workflow:

- `.github/workflows/attendance-strict-gates-prod.yml`

Required secrets/vars:

- Secret: `ATTENDANCE_ADMIN_JWT` (admin JWT)
- Variable (optional): `ATTENDANCE_API_BASE` (defaults to `http://142.171.239.56:8081/api`)
- Variable (optional): `ATTENDANCE_PROVISION_USER_ID` (to enable Gate 3 provisioning inside the gate runner)

Artifacts:

- Uploaded for 14 days:
  - `output/playwright/attendance-prod-acceptance/**`

### B) Manual Perf Baseline (10k)

Workflow:

- `.github/workflows/attendance-import-perf-baseline.yml`

Required secret:

- Secret: `ATTENDANCE_ADMIN_JWT`

Artifacts:

- Uploaded for 14 days:
  - `output/playwright/attendance-import-perf/**`

## Daily Record Template (Copy/Paste)

Date:
- Strict gates twice:
  - PASS/FAIL:
  - Evidence 1:
  - Evidence 2:
  - Notes:
- Metrics sanity:
  - PASS/FAIL:
  - Notes:
- 10k perf baseline:
  - PASS/FAIL:
  - Evidence:
  - previewMs:
  - commitMs:
  - Notes:
