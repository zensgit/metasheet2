# Attendance Production Readiness Verification (2026-02-07)

This document records the steps and evidence used to bring the Attendance plugin into a production-usable state and verify it end-to-end.

## Target Environment

- Web: `http://142.171.239.56:8081/attendance`
- API (via web proxy): `http://142.171.239.56:8081/api`
- Backend (host-local): `http://127.0.0.1:8900` (server-side only)

## Changes Landed

### 1) Import commit-token persistence + enforcement (merged as #109)

- Import commit tokens are DB-backed when `ATTENDANCE_IMPORT_REQUIRE_TOKEN=1`.
- If the DB schema is not ready (missing table), the API fails fast with a clear error (prevents silent/non-deterministic behavior on multi-node setups).
- Legacy endpoint `/api/attendance/import` is also protected when token enforcement is enabled (prevents bypass).

### 2) Docker/Nginx + deployment correctness (merged as #110)

- `docker/nginx.conf` updated to resolve `backend` via Docker DNS at runtime.
  - Prevents `502 Bad Gateway` after backend redeploys when the backend container IP changes.
- Deployment scripts + docs updated to use the correct migration entrypoint:
  - `packages/core-backend/dist/src/db/migrate.js`

## Server Deployment Procedure (Executed)

On `142.171.239.56`:

1. Update repo:
   - `git pull --ff-only` in `~/metasheet2`
2. Pull images:
   - `docker compose -f docker-compose.app.yml pull backend web`
3. Restart services:
   - `docker compose -f docker-compose.app.yml up -d`
4. Run migrations inside the backend container:
   - `docker compose -f docker-compose.app.yml exec -T backend node packages/core-backend/dist/src/db/migrate.js`
5. Restart web (nginx) to ensure it picks up the latest config:
   - `docker compose -f docker-compose.app.yml restart web`

## DB Migration Result (Expected)

The following migrations must be applied when `ATTENDANCE_IMPORT_REQUIRE_TOKEN=1`:

- `packages/core-backend/src/db/migrations/zzzz20260207150000_create_attendance_import_tokens.ts`

Optional (recommended) import reliability hardening:

- `packages/core-backend/src/db/migrations/zzzz20260208120000_add_attendance_import_idempotency_key.ts`
  - Adds `attendance_import_batches.idempotency_key` + unique index (per org) for faster lookup and stronger uniqueness.
  - Note: commit retries can still be de-duplicated without this column via `attendance_import_batches.meta.idempotencyKey` fallback (but without DB-enforced uniqueness).

## End-to-End Verification (Playwright)

We use the repo script:

- `scripts/verify-attendance-production-flow.mjs`

It verifies:

- Auth `/api/auth/me` returns `features.attendance=true`
- Attendance overview loads
- A punch request is attempted (best-effort)
- Adjustment request submission works
- Admin Center import flow:
  - load template
  - apply mapping + CSV
  - preview import
  - commit import (must use `/api/attendance/import/commit`, not legacy)
- Group + membership verification via API

### Command

```bash
AUTH_TOKEN="<ADMIN_JWT>" \
WEB_URL="http://142.171.239.56:8081/attendance" \
API_BASE="http://142.171.239.56:8081/api" \
OUTPUT_DIR="output/playwright/attendance-production-flow-remote-YYYYMMDD" \
HEADLESS="true" \
node scripts/verify-attendance-production-flow.mjs
```

### Evidence Artifacts

Artifacts are generated under:

- `output/playwright/attendance-production-flow-remote-latest/`
- `output/playwright/attendance-production-flow-remote-postfix/`

## Go/No-Go Criteria (Production-Usable)

Go when all are true:

1. `ATTENDANCE_IMPORT_REQUIRE_TOKEN=1` is enabled and migrations are applied.
2. `/api/attendance/import/prepare` + `/preview` + `/commit` works without relying on legacy `/api/attendance/import`.
3. Nginx `/api/*` proxy is stable across redeploys (no persistent 502 due to stale backend IP).
4. Playwright verification passes at least twice consecutively.
