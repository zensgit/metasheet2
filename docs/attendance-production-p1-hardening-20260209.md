# Attendance Production P1 Hardening (2026-02-09)

This document records the P1 hardening work completed after the initial "production usable" gates were passing.

P1 scope for this iteration:

1. Observability + alerts
2. Audit trail + retention
3. Admin productization (batch role provisioning + audit viewer)
4. Import performance (reduce DB roundtrips)
5. Security (rate limits + IP allowlist enforcement)

## Changes Shipped (Code)

### Observability

- New metrics (Prometheus):
  - `attendance_api_errors_total{route,method,status,error_code}`
  - `attendance_rate_limited_total{route,method}`
  - Source: `packages/core-backend/src/metrics/attendance-metrics.ts`
- Prometheus alerts:
  - `ops/prometheus/attendance-alerts.yml`
- Grafana dashboard:
  - `docker/observability/grafana/dashboards/attendance-overview.json`

### Audit Trail + Retention

- Attendance audit middleware (best-effort insert into `operation_audit_logs`):
  - `packages/core-backend/src/middleware/attendance-production.ts`
- Schema hardening migration (occurred_at + meta backfill):
  - `packages/core-backend/src/db/migrations/zzzz20260209100000_fix_operation_audit_logs_schema.ts`
- Retention worker (production-only by default):
  - `packages/core-backend/src/audit/operation-audit-retention.ts`

### Admin Productization

- Batch role provisioning API:
  - `POST /api/attendance-admin/users/batch/roles/assign`
  - `POST /api/attendance-admin/users/batch/roles/unassign`
- Audit log query API:
  - `GET /api/attendance-admin/audit-logs?q=&page=&pageSize=`
- Admin Center UI (Attendance -> Admin Center):
  - Batch Provisioning section
  - Audit Logs section

### Import Performance

- Import commit buffered bulk insert for import items:
  - `plugins/plugin-attendance/index.cjs`

### Security

- IP allowlist enforcement for import/export/admin endpoints (enabled when configured in `attendance.settings`).
- Rate limiting for import/export/admin write endpoints (enabled by default when `NODE_ENV=production`).
  - Env controls:
    - `ATTENDANCE_RATE_LIMIT_ENABLED=true|false`
    - `ATTENDANCE_RATE_LIMIT_IMPORT_PREPARE_PER_MIN`
    - `ATTENDANCE_RATE_LIMIT_IMPORT_PREVIEW_PER_MIN`
    - `ATTENDANCE_RATE_LIMIT_IMPORT_COMMIT_PER_MIN`
    - `ATTENDANCE_RATE_LIMIT_EXPORT_PER_MIN`
    - `ATTENDANCE_RATE_LIMIT_ADMIN_WRITE_PER_MIN`

## Verification (Strict Gates + Evidence)

We use the repo gate runner to validate:

- Strict API smoke:
  - `REQUIRE_ATTENDANCE_ADMIN_API=true`
  - `REQUIRE_IDEMPOTENCY=true`
  - `REQUIRE_IMPORT_EXPORT=true`
- Playwright desktop + mobile

Command (no secrets; token placeholder only):

```bash
REQUIRE_ATTENDANCE_ADMIN_API="true" \
REQUIRE_IDEMPOTENCY="true" \
REQUIRE_IMPORT_EXPORT="true" \
RUN_PREFLIGHT="false" \
API_BASE="http://142.171.239.56:8081/api" \
AUTH_TOKEN="<ADMIN_JWT>" \
EXPECT_PRODUCT_MODE="attendance" \
scripts/ops/attendance-run-gates.sh
```

Execution record (2026-02-09):

1. Strict run #1: PASS
   - Evidence: `output/playwright/attendance-prod-acceptance/20260209-123959/`
   - API smoke: `output/playwright/attendance-prod-acceptance/20260209-123959/gate-api-smoke.log`
2. Strict run #2 (consecutive): PASS
   - Evidence: `output/playwright/attendance-prod-acceptance/20260209-124300/`
3. Strict run #3: PASS
   - Evidence: `output/playwright/attendance-prod-acceptance/20260209-163619/`
4. Strict run #4 (consecutive): PASS
   - Evidence: `output/playwright/attendance-prod-acceptance/20260209-164032/`

Provisioning role-bundle scripts were also executed and stored under:

- `output/playwright/attendance-prod-acceptance/20260209-123959/gate-provision-employee.log`
- `output/playwright/attendance-prod-acceptance/20260209-123959/gate-provision-approver.log`
- `output/playwright/attendance-prod-acceptance/20260209-123959/gate-provision-admin.log`

Notes:

- Gate 1 (Preflight) was skipped in the recorded runs because the runner host did not have `docker/app.env`.
- The Playwright scripts treat `PUNCH_TOO_SOON` as a best-effort business guard; it must not fail the run.
- The provisioning script supports best-effort JWT refresh via `POST /api/auth/refresh-token` to avoid invalid-token flakiness.

## Ops Verification Additions (GA Enablers)

These checks are recommended for GA-level readiness but are not part of the original "production usable" gate set.

### 1) Metrics Sanity (host-only)

Run on the production host (backend binds to `127.0.0.1:8900`):

```bash
scripts/ops/attendance-check-metrics.sh
```

Expected:

- PASS and the Prometheus endpoint contains:
  - `attendance_api_errors_total`
  - `attendance_rate_limited_total`

### 2) Import Perf Baseline (10k, rollback enabled)

Run against the target environment (token placeholder only):

```bash
API_BASE="http://142.171.239.56:8081/api" \
AUTH_TOKEN="<ADMIN_JWT>" \
ROWS="10000" \
MODE="commit" \
ROLLBACK="true" \
node scripts/ops/attendance-import-perf.mjs
```

Notes:

- The perf script defaults to safe response-size flags for large `ROWS`:
  - `previewLimit=200`
  - `returnItems=false`
- Override if needed:
  - `PREVIEW_LIMIT=...`
  - `RETURN_ITEMS=true|false`
  - `ITEMS_LIMIT=...`

Evidence:

- `output/playwright/attendance-import-perf/<runId>/perf-summary.json`

## Local Observability Stack (Optional)

To view the new metrics/dashboard locally:

```bash
docker compose -f docker/observability/docker-compose.yml up -d
```

- Prometheus: http://localhost:9090
- Grafana: http://localhost:3000 (admin/admin)
- Dashboard: "Attendance Overview"
