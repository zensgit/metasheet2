# Attendance Production Delivery (2026-02-07)

This is the delivery package definition for bringing the Attendance plugin to a production-usable state.

## Scope (P0)

1. Users can load `/attendance`, refresh records, and submit adjustment requests.
2. Admins can import attendance data (CSV / DingTalk CSV) using:
   - `/api/attendance/import/template`
   - `/api/attendance/import/prepare`
   - `/api/attendance/import/preview`
   - `/api/attendance/import/commit`
3. Import commit tokens are safe across restarts (DB-backed when required).
4. Import commits support an optional `idempotencyKey` (deduplicates retries; unique per org).
   - Works even when the `attendance_import_batches.idempotency_key` column is not present by falling back to `attendance_import_batches.meta.idempotencyKey`.
   - Recommended hardening (uniqueness + faster lookup): `packages/core-backend/src/db/migrations/zzzz20260208120000_add_attendance_import_idempotency_key.ts`
5. Reverse proxy remains stable across backend redeploys (no stale backend container IP).
6. Repeatable acceptance using Playwright with stored artifacts.
7. Admins can provision employee/approver/admin permissions via the existing permission APIs.

Out of scope for this delivery:

- Advanced payroll rule engine / holiday business policies (can be layered on later)
- Lunar calendar logic
- Full workflow designer hardening

## Production Checklist

### Security

- Postgres and Redis must NOT be exposed on public interfaces.
  - Production compose must not include `ports: ["5432:5432"]` or `ports: ["6379:6379"]`.
  - For debug only, use `docker-compose.app.debug.yml` which binds DB/Redis to localhost.
- `docker/app.env` must not use default secrets.

### Deploy

1. Run preflight:
   - `scripts/ops/attendance-preflight.sh`
2. Deploy + migrate + restart web:
   - `scripts/ops/deploy-attendance-prod.sh`
   - GitHub Actions deploy path (`.github/workflows/docker-build.yml`) now also runs backend migration before smoke checks.
3. If large imports (10k+ rows) return `504 Gateway Time-out` via nginx:
   - Ensure `docker/nginx.conf` sets `proxy_read_timeout`/`proxy_send_timeout` high enough (example: `300s`), then restart the `web` container.
   - If you deploy via GitHub Actions (`.github/workflows/docker-build.yml`) and the production compose mounts `./docker/nginx.conf`,
     make sure the deploy host has pulled the latest `main` so the mounted config is up to date.

### Smoke / Acceptance

- GA daily gate runbook:
  - `docs/attendance-production-ga-daily-gates-20260209.md`

- Run all gates (recommended):
  - `API_BASE=... AUTH_TOKEN=... scripts/ops/attendance-run-gates.sh`
- Strict gates twice (stability PASS, recommended for Go/No-Go):
  - `API_BASE=... AUTH_TOKEN=... PROVISION_USER_ID=... scripts/ops/attendance-run-strict-gates-twice.sh`
- Host metrics sanity (run on production host):
  - `scripts/ops/attendance-check-metrics.sh`
- Import perf baseline (rollback enabled, recommended for GA):
  - `API_BASE=... AUTH_TOKEN=... ROWS=10000 MODE=commit COMMIT_ASYNC=true EXPORT_CSV=true ROLLBACK=true node scripts/ops/attendance-import-perf.mjs`
  - Optional threshold guardrails:
    - `MAX_PREVIEW_MS=120000 MAX_COMMIT_MS=180000 MAX_EXPORT_MS=30000 MAX_ROLLBACK_MS=10000`
- API smoke:
  - `scripts/ops/attendance-smoke-api.sh`
- Provision user permissions:
  - UI (Admin Center): `Attendance -> Admin Center -> User Access`
  - Script (admin token required): `scripts/ops/attendance-provision-user.sh`
- Playwright acceptance (desktop admin flow):
  - `scripts/verify-attendance-production-flow.mjs`
- Playwright acceptance (attendance-focused shell + mobile gating):
  - `scripts/verify-attendance-full-flow.mjs`
- GitHub Actions (recommended for daily verification):
  - Strict gates: `.github/workflows/attendance-strict-gates-prod.yml`
  - Perf baseline (scheduled + manual): `.github/workflows/attendance-import-perf-baseline.yml`
  - Daily dashboard + escalation: `.github/workflows/attendance-daily-gate-dashboard.yml`
  - Issue-to-channel sync (Slack/DingTalk): `.github/workflows/attendance-gate-issue-notify.yml`
    - Secrets (optional, at least one): `ATTENDANCE_ALERT_SLACK_WEBHOOK_URL`, `ATTENDANCE_ALERT_DINGTALK_WEBHOOK_URL`

## Rollback

If a deploy fails:

1. Roll back images by pinning `IMAGE_TAG` to the previous known-good tag.
2. Restart services:
   - `docker compose -f docker-compose.app.yml up -d`
3. Restart web to refresh nginx config:
   - `docker compose -f docker-compose.app.yml restart web`

Notes:

- DB migrations are forward-only. This delivery only adds tables; it is safe to keep them during rollback.

## Post-Delivery Backlog (P1/P2)

P1 (1-2 weeks, production hardening):
- Observability + alerts (implemented 2026-02-09):
  - Prometheus alert rules: `ops/prometheus/attendance-alerts.yml`
  - Grafana dashboard: `docker/observability/grafana/dashboards/attendance-overview.json`
- Audit trail + retention (implemented 2026-02-09):
  - Attendance audit inserts into `operation_audit_logs` (best-effort, write ops + exports).
  - Retention worker (production-only by default): `packages/core-backend/src/audit/operation-audit-retention.ts`
  - Admin audit API: `GET /api/attendance-admin/audit-logs`
- Audit logs CSV export (implemented 2026-02-10):
  - Admin API: `GET /api/attendance-admin/audit-logs/export.csv`
  - Admin Center UI: `Attendance -> Admin Center -> Audit Logs -> Export CSV`
- Admin productization (implemented 2026-02-09):
  - Batch role assign/unassign API:
    - `POST /api/attendance-admin/users/batch/roles/assign`
    - `POST /api/attendance-admin/users/batch/roles/unassign`
  - Admin Center UI:
    - Batch Provisioning (multi-UUID input)
    - Audit Logs viewer (search + paging + meta preview)
- Import performance (partial, implemented 2026-02-09 and 2026-02-10):
  - Import commit uses buffered bulk inserts for items (reduces DB roundtrips).
  - Import scalability flags (preview/commit response-size controls):
    - `previewLimit`, `returnItems`, `itemsLimit`
    - Doc: `docs/attendance-production-import-scalability-20260210.md`
  - Async commit jobs for large imports (implemented 2026-02-10):
    - `POST /api/attendance/import/commit-async`
    - `GET /api/attendance/import/jobs/:id`
    - Gate (default strict): `REQUIRE_IMPORT_ASYNC="true"` for `scripts/ops/attendance-smoke-api.mjs` / strict gates
  - Async preview jobs for ultra-large imports (implemented 2026-02-12):
    - `POST /api/attendance/import/preview-async`
    - `GET /api/attendance/import/jobs/:id` returns `kind="preview"` and `preview` result when completed
    - Gate switch: `REQUIRE_PREVIEW_ASYNC="true"` for `scripts/ops/attendance-smoke-api.mjs` / strict gates
  - Large preview chunking in Admin Center UI (implemented 2026-02-11):
    - `apps/web/src/views/AttendanceView.vue`
    - Splits >10k rows into chunked preview requests to avoid single-request timeout risk.
  - Admin audit + provisioning operability enhancements (implemented 2026-02-11):
    - `GET /api/attendance-admin/audit-logs/summary`
    - `GET /api/attendance-admin/audit-logs` now supports `actionPrefix`, `statusClass`, `errorCode`, `from`, `to`.
    - Batch role assign/unassign returns `affectedUserIds` and `unchangedUserIds`.
  - Metrics/alerts expansion (implemented 2026-02-11):
    - New metrics in `packages/core-backend/src/metrics/attendance-metrics.ts`:
      - `attendance_operation_requests_total`
      - `attendance_operation_failures_total`
      - `attendance_operation_latency_seconds`
    - Alert rules and dashboard updated:
      - `ops/prometheus/attendance-alerts.yml`
      - `docker/observability/grafana/dashboards/attendance-overview.json`
  - Gate stability hardening:
    - API smoke retries `POST /api/attendance/import/commit` (bounded; default `COMMIT_RETRIES=3`) by preparing a fresh commit token
      when the server responds with `HTTP 5xx` or commit-token errors.
    - Import commit now acquires a transaction-scoped advisory lock per `(orgId, idempotencyKey)` and performs
      a second idempotency read inside the transaction before insert, reducing duplicate-batch risk under concurrent retries.
  - Remaining: true streaming CSV parser + chunked persistence for extreme payloads (500k+ rows), to further reduce peak memory.
- Security (implemented 2026-02-09):
  - Rate limits for import/export/admin writes (production-only by default).
  - Optional IP allowlist enforcement (when configured in `attendance.settings`).

P2 (later, feature expansion):
- Payroll: full salary settlement pipeline (beyond payroll cycles and anomaly batching).
- Workflow designer hardening: end-to-end permissions, mobile policy, and operational safeguards.

## Current Production Status (2026-02-11)

Production v1 readiness remains **GO** on `main`.

Latest strict validation:

- Deploy after PR `#147`: [Build and Push Docker Images #21914265724](https://github.com/zensgit/metasheet2/actions/runs/21914265724) (`SUCCESS`)
- Strict gates (twice) with `require_batch_resolve=true`:
  - [Attendance Strict Gates (Prod) #21914381403](https://github.com/zensgit/metasheet2/actions/runs/21914381403) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/21914381403/20260211-165320-1/`
    - `output/playwright/ga/21914381403/20260211-165320-2/`

Latest closure validation after P1 `1+2+3` merge (PR `#149`):

- Deploy after PR `#149`: [Build and Push Docker Images #21915716951](https://github.com/zensgit/metasheet2/actions/runs/21915716951) (`SUCCESS`)
- Strict gates (twice) with `require_batch_resolve=true`:
  - [Attendance Strict Gates (Prod) #21916079926](https://github.com/zensgit/metasheet2/actions/runs/21916079926) (`SUCCESS`)
  - Workflow log confirms:
    - `REQUIRE_BATCH_RESOLVE: true`
    - `✅ Strict gates passed twice`
  - Evidence:
    - `output/playwright/ga/21916079926/20260211-174121-1/`
    - `output/playwright/ga/21916079926/20260211-174121-2/`
  - API smoke assertions in both runs:
    - `batch resolve ok`
    - `audit summary ok`
    - `idempotency ok`
    - `export csv ok`
    - `import async idempotency ok`
    - `SMOKE PASS`

Post-documentation re-validation on latest `main`:

- Docs commit: `803efa96`
- Strict gates (twice) with `require_batch_resolve=true`:
  - [Attendance Strict Gates (Prod) #21931280648](https://github.com/zensgit/metasheet2/actions/runs/21931280648) (`SUCCESS`)
  - Workflow log confirms:
    - `REQUIRE_BATCH_RESOLVE: true`
    - `✅ Strict gates passed twice`
  - Evidence:
    - `output/playwright/ga/21931280648/attendance-strict-gates-prod-21931280648-1/20260212-023217-1/`
    - `output/playwright/ga/21931280648/attendance-strict-gates-prod-21931280648-1/20260212-023217-2/`
  - API smoke assertions in both runs:
    - `batch resolve ok`
    - `audit summary ok`
    - `idempotency ok`
    - `export csv ok`
    - `import async idempotency ok`
    - `SMOKE PASS`

Latest head re-validation on `main` (post-`9f27c004`):

- Docs commit: `9f27c004`
- Strict gates (twice) with `require_batch_resolve=true`:
  - [Attendance Strict Gates (Prod) #21931376436](https://github.com/zensgit/metasheet2/actions/runs/21931376436) (`SUCCESS`)
  - Workflow log confirms:
    - `REQUIRE_BATCH_RESOLVE: true`
    - `✅ Strict gates passed twice`
  - Evidence:
    - `output/playwright/ga/21931376436/attendance-strict-gates-prod-21931376436-1/20260212-023656-1/`
    - `output/playwright/ga/21931376436/attendance-strict-gates-prod-21931376436-1/20260212-023656-2/`
  - API smoke assertions in both runs:
    - `batch resolve ok`
    - `audit summary ok`
    - `idempotency ok`
    - `export csv ok`
    - `import async idempotency ok`
    - `SMOKE PASS`

Async preview hardening validation on latest `main`:

- Feature commits:
  - `3dd6333b` (`feat(attendance): add async preview jobs and strict gate check`)
  - `0d3ced69` (`fix(attendance-import): allow preview-async idempotent retries without commitToken`)
- Deploy after fix:
  - [Build and Push Docker Images #21932058512](https://github.com/zensgit/metasheet2/actions/runs/21932058512) (`SUCCESS`)
- Strict gates (twice) with `require_preview_async=true` and `require_batch_resolve=true`:
  - [Attendance Strict Gates (Prod) #21932116429](https://github.com/zensgit/metasheet2/actions/runs/21932116429) (`SUCCESS`)
  - Workflow confirms:
    - `REQUIRE_PREVIEW_ASYNC: true`
    - `REQUIRE_BATCH_RESOLVE: true`
    - `✅ Strict gates passed twice`
  - Evidence:
    - `output/playwright/ga/21932116429/attendance-strict-gates-prod-21932116429-1/20260212-031409-1/`
    - `output/playwright/ga/21932116429/attendance-strict-gates-prod-21932116429-1/20260212-031409-2/`
  - API smoke assertions in both runs:
    - `preview async ok`
    - `batch resolve ok`
    - `audit summary ok`
    - `idempotency ok`
    - `export csv ok`
    - `import async idempotency ok`
    - `SMOKE PASS`

Operational conclusion:

- P0 delivery target is met for attendance-focused production usage.
- P1 `1+2+3` scope is now in place and validated on production strict gates.
- Current residual work is P2 or larger-scale optimization, not a P0 launch blocker.

Latest head re-validation on `main` (post-`08a7619e`):

- Head commit:
  - `08a7619e` (`feat(attendance): wire async preview into UI and strict gate defaults`)
- Strict gates run (workflow defaults; `REQUIRE_PREVIEW_ASYNC=true`):
  - [Attendance Strict Gates (Prod) #21932461116](https://github.com/zensgit/metasheet2/actions/runs/21932461116) (`SUCCESS`)
  - Workflow confirms:
    - `REQUIRE_PREVIEW_ASYNC: true`
    - `✅ Strict gates passed twice`
  - Evidence (downloaded artifact):
    - `output/playwright/ga/21932461116/20260212-033153-1/`
    - `output/playwright/ga/21932461116/20260212-033153-2/`
- Strict gates run (explicit full strictness; `require_batch_resolve=true`):
  - [Attendance Strict Gates (Prod) #21932569305](https://github.com/zensgit/metasheet2/actions/runs/21932569305) (`SUCCESS`)
  - Workflow confirms:
    - `REQUIRE_PREVIEW_ASYNC: true`
    - `REQUIRE_BATCH_RESOLVE: true`
    - `✅ Strict gates passed twice`
  - Evidence (downloaded artifact):
    - `output/playwright/ga/21932569305/20260212-033753-1/`
    - `output/playwright/ga/21932569305/20260212-033753-2/`
- API smoke assertions (both runs, both passes):
  - `product mode ok: mode=attendance`
  - `preview async ok`
  - `batch resolve ok` (for run `#21932569305`)
  - `audit export csv ok`
  - `audit summary ok`
  - `idempotency ok`
  - `export csv ok`
  - `import async idempotency ok`
  - `SMOKE PASS`
