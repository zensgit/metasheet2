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

### Smoke / Acceptance

- Run all gates (recommended):
  - `API_BASE=... AUTH_TOKEN=... scripts/ops/attendance-run-gates.sh`
- API smoke:
  - `scripts/ops/attendance-smoke-api.sh`
- Provision user permissions:
  - UI (Admin Center): `Attendance -> Admin Center -> User Access`
  - Script (admin token required): `scripts/ops/attendance-provision-user.sh`
- Playwright acceptance (desktop admin flow):
  - `scripts/verify-attendance-production-flow.mjs`
- Playwright acceptance (attendance-focused shell + mobile gating):
  - `scripts/verify-attendance-full-flow.mjs`

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
- Observability + alerts: import/approve error rate, latency, and failure reason aggregation (Grafana dashboards + Prometheus alerts).
- Audit trail: who imported/approved/changed rules, and when (admin-visible logs + retention policy).
- Admin productization: improve User Access UI (batch grant/revoke, templates, and audit traceability).
- Import performance: async/streaming preview + commit for large files (10k-100k rows), with timeout/retry strategy.
- Security: enforce import/export rate limits + optional IP allowlist by default; lock down admin endpoints with stronger guardrails.

P2 (later, feature expansion):
- Payroll: full salary settlement pipeline (beyond payroll cycles and anomaly batching).
- Workflow designer hardening: end-to-end permissions, mobile policy, and operational safeguards.
