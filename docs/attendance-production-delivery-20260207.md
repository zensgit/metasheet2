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
  - `API_BASE=... AUTH_TOKEN=... ROWS=10000 MODE=commit ROLLBACK=true node scripts/ops/attendance-import-perf.mjs`
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
  - Perf baseline (manual): `.github/workflows/attendance-import-perf-baseline.yml`

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
  - Gate stability hardening:
    - API smoke retries `POST /api/attendance/import/commit` (bounded; default `COMMIT_RETRIES=3`) by preparing a fresh commit token
      when the server responds with `HTTP 5xx` or commit-token errors.
  - Remaining: async/streaming preview + commit for large files (10k-100k rows), with timeout/retry strategy.
- Security (implemented 2026-02-09):
  - Rate limits for import/export/admin writes (production-only by default).
  - Optional IP allowlist enforcement (when configured in `attendance.settings`).

P2 (later, feature expansion):
- Payroll: full salary settlement pipeline (beyond payroll cycles and anomaly batching).
- Workflow designer hardening: end-to-end permissions, mobile policy, and operational safeguards.
