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
4. If large imports (200k+ rows) return `413 Payload Too Large`:
   - Ensure the backend is on a build that supports per-route import payload limits (shipped on `main` after `3b85463d`).
   - Optional env (override only when needed): `ATTENDANCE_IMPORT_JSON_LIMIT=50mb` (must be <= reverse proxy `client_max_body_size`).
5. For extreme-scale imports (200k-500k+ rows), prefer the CSV upload channel (`csvFileId`) instead of embedding `csvText` in JSON:
   - Ensure `ATTENDANCE_IMPORT_UPLOAD_DIR` is on a persistent volume (see `docker-compose.app.yml`).
   - Ensure nginx allows a larger body specifically for the upload endpoint:
     - `location /api/attendance/import/upload { client_max_body_size 120m; }` (see `docker/nginx.conf`)
   - Runbook: `docs/attendance-production-import-upload-channel-20260212.md`

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
  - Additional hardening (implemented 2026-02-12):
    - Streaming-style CSV row iteration (avoid full parsed matrix allocation).
    - Server-side CSV row cap guardrail via `ATTENDANCE_IMPORT_CSV_MAX_ROWS` (default `500000`, minimum `1000`).
    - `CSV_TOO_LARGE` mapped to explicit `HTTP 400` on preview/commit/import endpoints.
  - Import persistence tuning (implemented 2026-02-12):
    - Import chunk sizes are now env-tunable:
      - `ATTENDANCE_IMPORT_ITEMS_CHUNK_SIZE` (default `300`, range `50-1000`)
      - `ATTENDANCE_IMPORT_RECORDS_CHUNK_SIZE` (default `200`, range `50-1000`)
    - Work-context prefetch now has safety caps for ultra-large scopes:
      - `ATTENDANCE_IMPORT_PREFETCH_MAX_USERS` (default `5000`)
      - `ATTENDANCE_IMPORT_PREFETCH_MAX_WORK_DATES` (default `366`)
      - `ATTENDANCE_IMPORT_PREFETCH_MAX_SPAN_DAYS` (default `366`)
    - Import loops release processed row field payloads early to reduce heap pressure during large commits.
  - Remaining:
    - COPY-based fast path / staging-table pipeline for extreme payloads (500k+ rows).
    - Perf baseline refresh for 100k+ commit imports under the new tuning knobs.
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

Latest head re-validation on `main` (post-`87b12c7a`):

- Head commit:
  - `87b12c7a` (`feat(attendance): harden concurrent import idempotency`)
- Deploy workflow:
  - [Build and Push Docker Images #21932907464](https://github.com/zensgit/metasheet2/actions/runs/21932907464) (`SUCCESS`, build+deploy)
- Strict gates run (explicit full strictness):
  - [Attendance Strict Gates (Prod) #21932967682](https://github.com/zensgit/metasheet2/actions/runs/21932967682) (`SUCCESS`)
  - Workflow confirms:
    - `REQUIRE_PREVIEW_ASYNC: true`
    - `REQUIRE_BATCH_RESOLVE: true`
    - `✅ Strict gates passed twice`
  - Evidence (downloaded artifact):
    - `output/playwright/ga/21932967682/20260212-035905-1/`
    - `output/playwright/ga/21932967682/20260212-035905-2/`
- API smoke assertions in both runs:
  - `product mode ok: mode=attendance`
  - `preview async ok`
  - `batch resolve ok`
  - `audit export csv ok`
  - `audit summary ok`
  - `idempotency ok`
  - `export csv ok`
  - `import async idempotency ok`
  - `SMOKE PASS`

Latest head re-validation on `main` (post-`519251cb`):

- Head commit:
  - `519251cb` (`perf(attendance-import): reduce csv parse memory and enforce row cap`)
- Deploy workflow:
  - [Build and Push Docker Images #21934468090](https://github.com/zensgit/metasheet2/actions/runs/21934468090) (`SUCCESS`, build+deploy)
- Strict gates run (explicit full strictness):
  - [Attendance Strict Gates (Prod) #21934527245](https://github.com/zensgit/metasheet2/actions/runs/21934527245) (`SUCCESS`)
  - Workflow confirms:
    - `REQUIRE_PREVIEW_ASYNC: true`
    - `REQUIRE_BATCH_RESOLVE: true`
    - `✅ Strict gates passed twice`
  - Evidence (downloaded artifact):
    - `output/playwright/ga/21934527245/attendance-strict-gates-prod-21934527245-1/20260212-051738-1/`
    - `output/playwright/ga/21934527245/attendance-strict-gates-prod-21934527245-1/20260212-051738-2/`
- API smoke assertions in both runs:
  - `product mode ok: mode=attendance`
  - `batch resolve ok`
  - `preview async ok`
  - `audit export csv ok`
  - `audit summary ok`
  - `idempotency ok`
  - `export csv ok`
  - `import async idempotency ok`
  - `SMOKE PASS`
- Playwright production flow note:
  - `PUNCH_TOO_SOON` warning appears as expected business guardrail and does not fail the gate.

Latest head re-validation on `main` (post-`3b85463d`):

- Head commit:
  - `3b85463d` (`fix(attendance-import): allow larger preview payloads`)
  - Change: add per-route JSON body limit for `/api/attendance/import/*` via `ATTENDANCE_IMPORT_JSON_LIMIT` (default `50mb`) while keeping the global JSON limit at `10mb`.
- Deploy workflows:
  - [Build and Push Docker Images #21942979767](https://github.com/zensgit/metasheet2/actions/runs/21942979767) (`SUCCESS`)
  - [Deploy to Production #21942979808](https://github.com/zensgit/metasheet2/actions/runs/21942979808) (`SUCCESS`)
- Strict gates run (explicit full strictness; workflow_dispatch with `require_batch_resolve=true`):
  - [Attendance Strict Gates (Prod) #21943177102](https://github.com/zensgit/metasheet2/actions/runs/21943177102) (`SUCCESS`)
  - Evidence (downloaded artifact):
    - `output/playwright/ga/21943177102/attendance-strict-gates-prod-21943177102-1/20260212-103927-1/`
    - `output/playwright/ga/21943177102/attendance-strict-gates-prod-21943177102-1/20260212-103927-2/`
- Perf baseline (200k, async+rollback, export disabled): `PASS`
  - Run: [Attendance Import Perf Baseline #21943641804](https://github.com/zensgit/metasheet2/actions/runs/21943641804) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/21943641804/attendance-import-perf-21943641804-1/attendance-perf-mljcbmew-rsnwho/perf-summary.json`
  - previewMs: `11251`
  - commitMs: `566193`
  - rollbackMs: `2847`
  - Note: this run overrides `max_commit_ms=900000` to avoid treating expected extreme-payload latency as a regression.

Latest head re-validation on `main` (post-`90f78a05`):

- Head commit:
  - `90f78a05` (`perf(attendance): cache timezone formatters in import`)
  - Change: cache per-timezone `Intl.DateTimeFormat` instances used during import computations to reduce CPU overhead at `200k+` scale.
- Deploy workflows:
  - [Build and Push Docker Images #21944398404](https://github.com/zensgit/metasheet2/actions/runs/21944398404) (`SUCCESS`)
  - [Deploy to Production #21944398423](https://github.com/zensgit/metasheet2/actions/runs/21944398423) (`SUCCESS`)
- Strict gates run (explicit full strictness; workflow_dispatch with `require_batch_resolve=true`):
  - [Attendance Strict Gates (Prod) #21944498008](https://github.com/zensgit/metasheet2/actions/runs/21944498008) (`SUCCESS`)
  - Evidence (downloaded artifact):
    - `output/playwright/ga/21944498008/attendance-strict-gates-prod-21944498008-1/20260212-112109-1/`
    - `output/playwright/ga/21944498008/attendance-strict-gates-prod-21944498008-1/20260212-112109-2/`
- Perf baseline (200k, async+rollback, export disabled): `PASS`
  - Run: [Attendance Import Perf Baseline #21944618100](https://github.com/zensgit/metasheet2/actions/runs/21944618100) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/21944618100/attendance-import-perf-21944618100-1/attendance-perf-mljdfef2-ithiuu/perf-summary.json`
  - previewMs: `10086`
  - commitMs: `232725`
  - rollbackMs: `1874`
  - Note: this run overrides `max_commit_ms=900000` to avoid treating expected extreme-payload latency as a regression.
- Perf impact (200k commit-async; same env):
  - Before caching Intl formatters: commitMs `566193`
  - After caching Intl formatters: commitMs `232725`

Latest head re-validation on `main` (post-`91c21cab`):

- Head commit:
  - `91c21cab` (`perf(attendance-import): reduce SQL placeholder overhead with unnest`)
- Deploy workflow:
  - [Build and Push Docker Images #21941181821](https://github.com/zensgit/metasheet2/actions/runs/21941181821) (`SUCCESS`, build+deploy)
- Strict gates run (explicit full strictness; workflow_dispatch with `require_batch_resolve=true`):
  - [Attendance Strict Gates (Prod) #21941278046](https://github.com/zensgit/metasheet2/actions/runs/21941278046) (`SUCCESS`)
  - Evidence (downloaded artifact):
    - `output/playwright/ga/21941278046/attendance-strict-gates-prod-21941278046-1/20260212-094127-1/`
    - `output/playwright/ga/21941278046/attendance-strict-gates-prod-21941278046-1/20260212-094127-2/`
- Bulk write defaults (runtime switches optional):
  - `ATTENDANCE_IMPORT_RECORD_UPSERT_MODE=unnest|values` (default `unnest`)
  - `ATTENDANCE_IMPORT_ITEMS_INSERT_MODE=unnest|values` (default `unnest`)
- Perf baseline (10k, async+export+rollback, thresholds enabled): `PASS`
  - Run: [Attendance Import Perf Baseline #21941424853](https://github.com/zensgit/metasheet2/actions/runs/21941424853) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/21941424853/attendance-import-perf-21941424853-1/attendance-perf-mlj9w039-v55261/perf-summary.json`
  - previewMs: `2854`
  - commitMs: `26590`
  - exportMs: `379`
  - rollbackMs: `139`
- Perf baseline (100k, async+rollback, export disabled, thresholds enabled): `PASS`
  - Run: [Attendance Import Perf Baseline #21941478702](https://github.com/zensgit/metasheet2/actions/runs/21941478702) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/21941478702/attendance-import-perf-21941478702-1/attendance-perf-mlj9y3ri-a801np/perf-summary.json`
  - previewMs: `6657`
  - commitMs: `257121`
  - rollbackMs: `1118`
- Perf baseline (10k, async+export+rollback, thresholds enabled): `PASS`
  - Run: [Attendance Import Perf Baseline #21939937555](https://github.com/zensgit/metasheet2/actions/runs/21939937555) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/21939937555/attendance-import-perf-21939937555-1/attendance-perf-mlj87q05-533e4g/perf-summary.json`
  - previewMs: `3545`
  - commitMs: `28011`
  - exportMs: `452`
  - rollbackMs: `121`
- Perf baseline (100k, async+rollback, export disabled, thresholds enabled): `PASS`
  - Run: [Attendance Import Perf Baseline #21940682621](https://github.com/zensgit/metasheet2/actions/runs/21940682621) (`SUCCESS`)
  - Evidence:
    - `output/playwright/ga/21940682621/attendance-import-perf-21940682621-1/attendance-perf-mlj92fhi-th1qdz/perf-summary.json`
  - previewMs: `5505`
  - commitMs: `254353`
  - rollbackMs: `901`

Latest head re-validation on `main` (post-`ad28cfe6`):

- Head commit:
  - `ad28cfe6` (`test(attendance): cover csv row cap and refresh production evidence`)
- Deploy workflow:
  - [Build and Push Docker Images #21934704705](https://github.com/zensgit/metasheet2/actions/runs/21934704705) (`SUCCESS`, build+deploy)
- Strict gates run (explicit full strictness):
  - [Attendance Strict Gates (Prod) #21934774035](https://github.com/zensgit/metasheet2/actions/runs/21934774035) (`SUCCESS`)
  - Workflow confirms:
    - `REQUIRE_PREVIEW_ASYNC: true`
    - `REQUIRE_BATCH_RESOLVE: true`
    - `✅ Strict gates passed twice`
  - Evidence (downloaded artifact):
    - `output/playwright/ga/21934774035/attendance-strict-gates-prod-21934774035-1/20260212-052932-1/`
    - `output/playwright/ga/21934774035/attendance-strict-gates-prod-21934774035-1/20260212-052932-2/`
- API smoke assertions in both runs:
  - `product mode ok: mode=attendance`
  - `batch resolve ok`
  - `preview async ok`
  - `audit export csv ok`
  - `audit summary ok`
  - `idempotency ok`
  - `export csv ok`
  - `import async idempotency ok`
  - `SMOKE PASS`

Latest head re-validation on `main` (post-`250dbaab`):

- Head commit:
  - `250dbaab` (`perf(attendance-import): tune chunking and cap prefetch scope`)
- Deploy workflow:
  - [Build and Push Docker Images #21935222964](https://github.com/zensgit/metasheet2/actions/runs/21935222964) (`SUCCESS`, build+deploy)
- Strict gates run (explicit full strictness):
  - [Attendance Strict Gates (Prod) #21935284365](https://github.com/zensgit/metasheet2/actions/runs/21935284365) (`SUCCESS`)
  - Workflow confirms:
    - `REQUIRE_PREVIEW_ASYNC: true`
    - `REQUIRE_BATCH_RESOLVE: true`
    - `✅ Strict gates passed twice`
  - Evidence (downloaded artifact):
    - `output/playwright/ga/21935284365/attendance-strict-gates-prod-21935284365-1/20260212-055327-1/`
    - `output/playwright/ga/21935284365/attendance-strict-gates-prod-21935284365-1/20260212-055327-2/`
- API smoke assertions in both runs:
  - `product mode ok: mode=attendance`
  - `batch resolve ok`
  - `preview async ok`
  - `audit export csv ok`
  - `audit summary ok`
  - `idempotency ok`
  - `export csv ok`
  - `import async idempotency ok`
  - `SMOKE PASS`
- Playwright production flow note:
  - `PUNCH_TOO_SOON` warning appears as expected business guardrail and does not fail the gate.

Latest head re-validation on `main` (post-`2305b630`):

- Head commit:
  - `2305b630` (`perf(attendance-import): batch upsert attendance_records`)
- Deploy workflow:
  - [Build and Push Docker Images #21939493555](https://github.com/zensgit/metasheet2/actions/runs/21939493555) (`SUCCESS`, build+deploy)
- Strict gates run (explicit full strictness; workflow_dispatch with `require_batch_resolve=true`):
  - [Attendance Strict Gates (Prod) #21939600178](https://github.com/zensgit/metasheet2/actions/runs/21939600178) (`SUCCESS`)
  - Evidence (downloaded artifact):
    - `output/playwright/ga/21939600178/attendance-strict-gates-prod-21939600178-1/20260212-084738-1/`
    - `output/playwright/ga/21939600178/attendance-strict-gates-prod-21939600178-1/20260212-084738-2/`
- API smoke assertions in both runs:
  - `product mode ok: mode=attendance`
  - `batch resolve ok`
  - `preview async ok`
  - `audit export csv ok`
  - `audit summary ok`
  - `idempotency ok`
  - `export csv ok`
  - `import async idempotency ok`
  - `SMOKE PASS`
- Playwright production flow note:
  - `PUNCH_TOO_SOON` warning appears as expected business guardrail and does not fail the gate.
