# Smoke Verification (CI)

- Date: 2026-01-06 08:48 (local)
- Workflow: Smoke Verify
- Run ID: 20733919130
- Branch: work/20251231-next
- Commit: 2d9145c5 (HEAD at run time)
- Result: PASS

## Environment

- Runner: GitHub Actions (ubuntu-latest)
- API_BASE: http://127.0.0.1:7778
- WEB_BASE: http://127.0.0.1:8899
- DB: postgresql://postgres:postgres@localhost:5432/metasheet
- RUN_UNIVER_UI_SMOKE: true
- SMOKE_SKIP_WEB: false

## Steps (from workflow)

1. Install dependencies (pnpm)
2. Start Postgres service
3. Run migrations
4. Start backend + web
5. Run smoke suite (scripts/verify-smoke-core.mjs)
6. Run Univer UI smoke (scripts/verify-univer-ui-smoke.mjs)
7. Upload artifacts

## Results

All checks passed:

- api.health: 200 OK
- api.dev-token: 200 OK
- api.univer-meta.sheets: 200 OK
- api.univer-meta.fields: 200 OK
- api.univer-meta.views: 200 OK
- api.univer-meta.records-summary: skipped
- api.spreadsheets: skipped
- web.home: 200 OK
- Univer UI smoke: PASSED (route gated fallback applied)

## Artifacts

Downloaded locally to:

- tmp/ci-smoke-20733919130/smoke/smoke-report.json
- tmp/ci-smoke-20733919130/smoke/backend.log
- tmp/ci-smoke-20733919130/smoke/web.log
