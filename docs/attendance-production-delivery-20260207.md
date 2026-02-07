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
4. Reverse proxy remains stable across backend redeploys (no stale backend container IP).
5. Repeatable acceptance using Playwright with stored artifacts.
6. Admins can provision employee/approver/admin permissions via the existing permission APIs.

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
