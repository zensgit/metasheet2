# Smoke Verification (Local)

- Date: 2026-01-06 08:16 (local)
- Scope: core-backend smoke (API only, web skipped)
- Result: PASS

## Environment

- Repo: /Users/huazhou/Downloads/Github/metasheet2
- API_BASE: http://127.0.0.1:7778
- WEB_BASE: http://127.0.0.1:8899 (skipped)
- DB: postgresql://metasheet:metasheet@127.0.0.1:5435/metasheet
- Runtime: local dev

## Steps

1. Start Postgres
   - docker compose -f docker/dev-postgres.yml up -d
2. Run migrations
   - pnpm --filter @metasheet/core-backend migrate
3. Start backend
   - PORT=7778 DATABASE_URL=... DISABLE_WORKFLOW=true DISABLE_EVENT_BUS=true SKIP_PLUGINS=true RBAC_BYPASS=true pnpm --filter @metasheet/core-backend dev:core
4. Run smoke script
   - SMOKE_SKIP_WEB=true node scripts/verify-smoke-core.mjs

## Results

All checks passed:

- api.health: 200 OK
- api.dev-token: 200 OK
- api.univer-meta.sheets: 200 OK
- api.univer-meta.fields: 200 OK
- api.univer-meta.views: 200 OK
- api.univer-meta.records-summary: 200 OK
- api.spreadsheets: skipped (not in scope)
- web.home: skipped (SMOKE_SKIP_WEB=true)

## Artifacts

- Report: artifacts/smoke/local/smoke-report.json
- Backend log: artifacts/smoke/local/backend.log
