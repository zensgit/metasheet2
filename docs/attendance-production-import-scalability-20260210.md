# Attendance Import Scalability (2026-02-10)

This document records the next-stage hardening focused on **large CSV imports (10k-100k rows)**.

The immediate goal is to prevent UI/server failures caused by:

- preview responses returning tens of thousands of computed rows
- commit responses returning huge `items` arrays (memory + payload size)

This work is **backward-compatible**: existing clients behave the same unless they opt into the new flags.

## Changes Shipped

### 1) Import Payload Flags (Back-End)

`POST /api/attendance/import/preview` and `POST /api/attendance/import/commit` now accept:

- `previewLimit?: number`
  - When set and `rowCount > previewLimit`, the preview response returns at most `previewLimit` computed rows.
  - Validation + dedup stats still reflect the full payload.
- `returnItems?: boolean`
  - Default: `true` (backward compatible).
  - When `false`, commit response returns `items: []` while still returning `imported` and `batchId`.
- `itemsLimit?: number`
  - Optional cap for commit response `items` length when `returnItems=true`.

Implementation:

- `/Users/huazhou/Downloads/Github/metasheet2/plugins/plugin-attendance/index.cjs`

### 2) Preview Response Additions

When `previewLimit` is set, preview response adds:

- `rowCount`: total resolved rows (after building rows from csv/entries)
- `truncated`: boolean
- `previewLimit`: echo
- `stats`: `{ rowCount, invalid, duplicates }` (counts across the full payload)

### 3) Commit Response Additions

When `returnItems=false` or `itemsLimit` is hit, commit response includes:

- `itemsTruncated`: boolean
- `imported` remains accurate even when `items` is empty/limited

### 4) Web UI Defaults (Large Imports)

When the payload contains a large `rows[]` or `csvText` (heuristic: `> 2000` rows), the UI automatically:

- uses `previewLimit=200` for preview
- uses `returnItems=false` for commit (and keeps `itemsLimit=200` as a safe default)

You can override by explicitly setting these fields in the JSON payload editor.

Implementation:

- `/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/AttendanceView.vue`

### 5) Perf Harness Defaults

`scripts/ops/attendance-import-perf.mjs` now defaults to safe flags for large `ROWS`:

- `previewLimit=200` when `ROWS > 2000`
- `returnItems=false` when `ROWS > 2000`

Env overrides:

- `PREVIEW_LIMIT=...`
- `RETURN_ITEMS=true|false`
- `ITEMS_LIMIT=...`

Implementation:

- `/Users/huazhou/Downloads/Github/metasheet2/scripts/ops/attendance-import-perf.mjs`

### 6) Async Commit Jobs (Large Commits)

For very large commits (example: `50k+` rows), we support an **async commit** mode that:

- enqueues a durable job record
- processes the import out-of-band
- lets clients poll job progress without holding a long-running HTTP request open

New endpoints:

- `POST /api/attendance/import/commit-async`
  - Accepts the same payload as `POST /api/attendance/import/commit` (including `commitToken`).
  - Returns: `{ job: { id, status, progress, total, batchId?, ... }, idempotent?: boolean }`
  - If `idempotencyKey` is provided and a job already exists for `(orgId, idempotencyKey)`, the API returns the existing job without consuming a new commit token.
- `GET /api/attendance/import/jobs/:id`
  - Returns the job record until `status=completed` (includes `batchId`) or `status=failed` (includes `error`).

Storage:

- New table: `attendance_import_jobs`
- Migration:
  - `/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/migrations/zzzz20260210120000_create_attendance_import_jobs.ts`

Implementation:

- `/Users/huazhou/Downloads/Github/metasheet2/plugins/plugin-attendance/index.cjs`

Web UI:

- When import size is above `IMPORT_ASYNC_ROW_THRESHOLD` (default: `50000`), the UI automatically uses `commit-async` and shows a polling status panel.
- `/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/AttendanceView.vue`

## Verification

### A) Back-End Integration Tests

New test coverage verifies:

- preview truncation (`previewLimit=1` with `rowCount=2`)
- commit response suppression (`returnItems=false` with `imported=1` and `items=[]`)

File:

- `/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/integration/attendance-plugin.test.ts`

Run only the attendance integration suite:

```bash
pnpm --filter @metasheet/core-backend exec vitest \
  --config vitest.integration.config.ts \
  run tests/integration/attendance-plugin.test.ts
```

### B) Web Build + Unit Specs

```bash
pnpm --filter @metasheet/web exec vitest run --watch=false
pnpm --filter @metasheet/web build
```

### C) Perf Baseline (Staging/Pre-Prod Recommended)

Token placeholder only (do not paste real tokens into docs):

```bash
API_BASE="http://142.171.239.56:8081/api" \
AUTH_TOKEN="<ADMIN_JWT>" \
ROWS="10000" \
MODE="commit" \
ROLLBACK="true" \
node scripts/ops/attendance-import-perf.mjs
```

Evidence directory:

- `output/playwright/attendance-import-perf/<runId>/perf-summary.json`

### D) Async Commit Baseline (Large Commits)

Token placeholder only (do not paste real tokens into docs):

```bash
API_BASE="http://142.171.239.56:8081/api" \
AUTH_TOKEN="<ADMIN_JWT>" \
ROWS="50000" \
MODE="commit" \
COMMIT_ASYNC="true" \
ROLLBACK="true" \
EXPORT_CSV="false" \
node scripts/ops/attendance-import-perf.mjs
```

Expected:

- commit returns `jobId` and completes with `status=completed`
- `perf-summary.json` includes `commitAsync: true`

## Remote Execution Record (2026-02-10)

Strict gates (2x consecutive): `PASS`

Evidence 1:
- `output/playwright/attendance-prod-acceptance/20260210-130211/`

Evidence 2:
- `output/playwright/attendance-prod-acceptance/20260210-130454/`

API smoke log contains: `idempotency ok`, `export csv ok`

Perf baselines:

- 10k commit + export + rollback: `PASS`
  Evidence: `output/playwright/attendance-import-perf/attendance-perf-mlgm7tss-775i34/perf-summary.json`
  previewMs: `3462`
  commitMs: `108327`
  exportMs: `1106`
  rollbackMs: `327`
- 50k preview: `PASS`
  Evidence: `output/playwright/attendance-import-perf/attendance-perf-mlgmasnj-1bo840/perf-summary.json`
  previewMs: `5217`
- 100k preview: `PASS`
  Evidence: `output/playwright/attendance-import-perf/attendance-perf-mlgmb8xc-7hkkzr/perf-summary.json`
  previewMs: `5486`

Notes:

- For `ROWS > 2000`, the perf harness defaults to `previewLimit=200` and `returnItems=false` to avoid huge responses.
- If 10k+ commits time out through nginx, increase web proxy timeouts (example: `proxy_read_timeout 300s`) and restart the `web` container.

## Update (2026-02-10, post-merge PR #131)

Strict gates (2x consecutive): `PASS`

Evidence:

- `output/playwright/attendance-prod-acceptance/20260210-143245/`
- `output/playwright/attendance-prod-acceptance/20260210-143523/`

Perf baseline (10k commit + rollback): `PASS`

- Evidence (downloaded from GA artifact):
  - `output/playwright/ga/21868374518/attendance-import-perf-21868374518-1/attendance-perf-mlgomass-j77nax/perf-summary.json`
- previewMs: `2877`
- commitMs: `62440` (improved from `108327` in the earlier baseline)
- rollbackMs: `207`

## Update (2026-02-11): Async Commit Jobs (Local Verification)

Async commit + job polling is now implemented and verified locally (token placeholder only; do not paste secrets into docs):

- 50k commit-async + rollback: `PASS`
  Evidence: `output/playwright/attendance-import-perf/attendance-perf-mlgts55j-o4ky90/perf-summary.json`
  - previewMs: `4577`
  - commitMs: `733294`
  - rollbackMs: `141`
- Integration tests: `PASS`
  Evidence: `output/playwright/attendance-import-perf/attendance-perf-mlgts55j-o4ky90/integration-tests.log`
- Web build: `PASS`
  Evidence: `output/playwright/attendance-import-perf/attendance-perf-mlgts55j-o4ky90/web-build.log`

## Update (2026-02-12): Streaming-Style CSV Parse + Row Cap Guardrail

The import parser now iterates CSV rows directly (instead of materializing a full intermediate matrix), and adds a server-side CSV size guardrail:

- Runtime guardrail env:
  - `ATTENDANCE_IMPORT_CSV_MAX_ROWS` (default `500000`, minimum `1000`)
- Behavior:
  - Exceeding the guardrail returns `HTTP 400` with `error.code = CSV_TOO_LARGE`.
  - Guardrail is enforced consistently across `preview`, `commit`, `import`, and async job paths.

Verification:

- Integration tests: `PASS`
  - `pnpm --filter @metasheet/core-backend test:integration:attendance`
  - includes `rejects oversized CSV payloads with CSV_TOO_LARGE`
- Backend build: `PASS`
  - `pnpm --filter @metasheet/core-backend build`
- Remote strict gates (2x): `PASS`
  - Run: [Attendance Strict Gates (Prod) #21934527245](https://github.com/zensgit/metasheet2/actions/runs/21934527245)
  - Evidence:
    - `output/playwright/ga/21934527245/attendance-strict-gates-prod-21934527245-1/20260212-051738-1/`
    - `output/playwright/ga/21934527245/attendance-strict-gates-prod-21934527245-1/20260212-051738-2/`

## Update (2026-02-12): Import Chunk/Prefetch Tuning for 100k+ Stability

To reduce memory pressure and oversized prefetch queries on very large imports, commit pipelines now include tunable chunking and prefetch caps:

- Chunk tuning envs:
  - `ATTENDANCE_IMPORT_ITEMS_CHUNK_SIZE` (default `300`, range `50-1000`)
  - `ATTENDANCE_IMPORT_RECORDS_CHUNK_SIZE` (default `200`, range `50-1000`)
- Prefetch safety caps:
  - `ATTENDANCE_IMPORT_PREFETCH_MAX_USERS` (default `5000`)
  - `ATTENDANCE_IMPORT_PREFETCH_MAX_WORK_DATES` (default `366`)
  - `ATTENDANCE_IMPORT_PREFETCH_MAX_SPAN_DAYS` (default `366`)
- Runtime behavior:
  - If import scope exceeds any prefetch cap, the service skips bulk prefetch and falls back to per-row work-context resolution.
  - Processed row field payloads are released early in commit loops to reduce peak heap usage.

Verification:

- Local integration tests: `PASS`
  - `pnpm --filter @metasheet/core-backend test:integration:attendance`
- Local backend build: `PASS`
  - `pnpm --filter @metasheet/core-backend build`
- Remote strict gates (2x): `PASS`
  - Run: [Attendance Strict Gates (Prod) #21935284365](https://github.com/zensgit/metasheet2/actions/runs/21935284365)
  - Evidence:
    - `output/playwright/ga/21935284365/attendance-strict-gates-prod-21935284365-1/20260212-055327-1/`
    - `output/playwright/ga/21935284365/attendance-strict-gates-prod-21935284365-1/20260212-055327-2/`

## Update (2026-02-12): Chunked DB Persistence (Batch UPSERT attendance_records)

For large commits, a major bottleneck was the per-row `upsertAttendanceRecord()` query loop. We now compute upsert values in memory (after a bulk `SELECT ... FOR UPDATE`) and persist a whole chunk in a single multi-row UPSERT:

- New helpers:
  - `computeAttendanceRecordUpsertValues(...)`
  - `batchUpsertAttendanceRecords(client, rows)`
- Applied to both commit paths:
  - sync: `POST /api/attendance/import/commit`
  - async: import commit worker (`processAsyncImportCommitJob`)

This reduces DB round-trips and evens out latency variance for `10k+` imports.

Verification:

- Local integration tests: `PASS`
  - `pnpm --filter @metasheet/core-backend test:integration:attendance`
- Local backend build: `PASS`
  - `pnpm --filter @metasheet/core-backend build`
- Remote strict gates (2x): `PASS`
  - Run: [Attendance Strict Gates (Prod) #21939600178](https://github.com/zensgit/metasheet2/actions/runs/21939600178)
  - Evidence:
    - `output/playwright/ga/21939600178/attendance-strict-gates-prod-21939600178-1/20260212-084738-1/`
    - `output/playwright/ga/21939600178/attendance-strict-gates-prod-21939600178-1/20260212-084738-2/`
- Perf baseline (10k, async+export+rollback, thresholds enabled): `PASS`
  - Run: [Attendance Import Perf Baseline #21939937555](https://github.com/zensgit/metasheet2/actions/runs/21939937555)
  - Evidence:
    - `output/playwright/ga/21939937555/attendance-import-perf-21939937555-1/attendance-perf-mlj87q05-533e4g/perf-summary.json`
  - previewMs: `3545`
  - commitMs: `28011`
  - exportMs: `452`
  - rollbackMs: `121`
- Perf baseline (100k, async+rollback, export disabled, thresholds enabled): `PASS`
  - Run: [Attendance Import Perf Baseline #21940682621](https://github.com/zensgit/metasheet2/actions/runs/21940682621)
  - Evidence:
    - `output/playwright/ga/21940682621/attendance-import-perf-21940682621-1/attendance-perf-mlj92fhi-th1qdz/perf-summary.json`
  - previewMs: `5505`
  - commitMs: `254353`
  - rollbackMs: `901`

## Update (2026-02-12): UNNEST-Based Bulk Writes (Reduce SQL Placeholder Overhead)

To reduce SQL statement size and placeholder count during large commits, bulk writes now use `unnest(...)` arrays by default:

- `attendance_records` upserts (chunked) use array params instead of expanding `13 * chunkSize` placeholders.
- `attendance_import_items` inserts (chunked) use array params + constants for `(batchId, orgId)` instead of expanding `7 * chunkSize` placeholders.

Runtime switches (optional):

- `ATTENDANCE_IMPORT_RECORD_UPSERT_MODE=unnest|values` (default `unnest`)
- `ATTENDANCE_IMPORT_ITEMS_INSERT_MODE=unnest|values` (default `unnest`)

Verification:

- Remote strict gates (2x): `PASS`
  - Run: [Attendance Strict Gates (Prod) #21941278046](https://github.com/zensgit/metasheet2/actions/runs/21941278046)
  - Evidence:
    - `output/playwright/ga/21941278046/attendance-strict-gates-prod-21941278046-1/20260212-094127-1/`
    - `output/playwright/ga/21941278046/attendance-strict-gates-prod-21941278046-1/20260212-094127-2/`
- Perf baseline (10k, async+export+rollback): `PASS`
  - Run: [Attendance Import Perf Baseline #21941424853](https://github.com/zensgit/metasheet2/actions/runs/21941424853)
  - Evidence:
    - `output/playwright/ga/21941424853/attendance-import-perf-21941424853-1/attendance-perf-mlj9w039-v55261/perf-summary.json`
  - previewMs: `2854`
  - commitMs: `26590`
  - exportMs: `379`
  - rollbackMs: `139`
- Perf baseline (100k, async+rollback, export disabled): `PASS`
  - Run: [Attendance Import Perf Baseline #21941478702](https://github.com/zensgit/metasheet2/actions/runs/21941478702)
  - Evidence:
    - `output/playwright/ga/21941478702/attendance-import-perf-21941478702-1/attendance-perf-mlj9y3ri-a801np/perf-summary.json`
  - previewMs: `6657`
  - commitMs: `257121`
  - rollbackMs: `1118`

## Update (2026-02-12): Import JSON Body Limit (Unblock 200k+ CSV Payloads)

The perf harness (and large real-world CSV imports) submit `csvText` inside a JSON body. For `200k` rows this exceeds the global
`express.json({ limit: '10mb' })` parser limit and can return `HTTP 413 Payload Too Large`.

Change shipped:

- Keep global JSON limit at `10mb` (DoS guard).
- Add a larger per-route JSON parser for `/api/attendance/import/*`:
  - Env: `ATTENDANCE_IMPORT_JSON_LIMIT` (default `50mb`).
  - Adds a lightweight auth-header precheck to avoid parsing unauthenticated large payloads.
- Implementation: `/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/index.ts`

Verification:

- Remote strict gates (2x; workflow_dispatch with `require_batch_resolve=true`): `PASS`
  - Run: [Attendance Strict Gates (Prod) #21943177102](https://github.com/zensgit/metasheet2/actions/runs/21943177102)
  - Evidence:
    - `output/playwright/ga/21943177102/attendance-strict-gates-prod-21943177102-1/20260212-103927-1/`
    - `output/playwright/ga/21943177102/attendance-strict-gates-prod-21943177102-1/20260212-103927-2/`
- Perf baseline (200k, async+rollback, export disabled): `PASS`
  - Run: [Attendance Import Perf Baseline #21943641804](https://github.com/zensgit/metasheet2/actions/runs/21943641804)
  - Evidence:
    - `output/playwright/ga/21943641804/attendance-import-perf-21943641804-1/attendance-perf-mljcbmew-rsnwho/perf-summary.json`
  - previewMs: `11251`
  - commitMs: `566193`
  - rollbackMs: `2847`
  - Note: this run overrides `max_commit_ms=900000` to avoid treating expected extreme-payload latency as a regression.

## Update (2026-02-12): Cache Intl Timezone Formatters (Reduce 200k Commit Latency)

Large imports call `parseImportedDateTime()` and `computeMetrics()` per row. Previously, helper functions like `getZonedMinutes()`
created new `Intl.DateTimeFormat(...)` instances per row, which adds significant CPU overhead at `200k+` scale.

Change shipped:

- Cache per-timezone `Intl.DateTimeFormat` instances used for:
  - work-date formatting
  - zoned minute extraction
  - zoned parts extraction (offset calculations)
- Replace `buildZonedDate()`'s `toLocaleString()` hack with a `zonedTimeToUtc()` conversion that reuses cached formatters.
- Implementation: `/Users/huazhou/Downloads/Github/metasheet2/plugins/plugin-attendance/index.cjs`

Verification:

- Remote strict gates (2x; workflow_dispatch with `require_batch_resolve=true`): `PASS`
  - Run: [Attendance Strict Gates (Prod) #21944498008](https://github.com/zensgit/metasheet2/actions/runs/21944498008)
  - Evidence:
    - `output/playwright/ga/21944498008/attendance-strict-gates-prod-21944498008-1/20260212-112109-1/`
    - `output/playwright/ga/21944498008/attendance-strict-gates-prod-21944498008-1/20260212-112109-2/`
- Perf baseline (200k, async+rollback, export disabled): `PASS`
  - Run: [Attendance Import Perf Baseline #21944618100](https://github.com/zensgit/metasheet2/actions/runs/21944618100)
  - Evidence:
    - `output/playwright/ga/21944618100/attendance-import-perf-21944618100-1/attendance-perf-mljdfef2-ithiuu/perf-summary.json`
  - previewMs: `10086`
  - commitMs: `232725`
  - rollbackMs: `1874`

Perf impact (200k commit-async; same env):

- Before caching (2026-02-12): commitMs `566193`
- After caching (2026-02-12): commitMs `232725`

Additional perf baseline (300k, async+rollback, export disabled): `PASS`

- Run: [Attendance Import Perf Baseline #21944960433](https://github.com/zensgit/metasheet2/actions/runs/21944960433)
- Evidence:
  - `output/playwright/ga/21944960433/attendance-import-perf-21944960433-1/attendance-perf-mljdtnov-wh6efv/perf-summary.json`
- previewMs: `13965`
- commitMs: `350509`
- rollbackMs: `4451`

Additional perf baseline (500k, async+rollback, export disabled): `PASS`

- Run: [Attendance Import Perf Baseline #21946247688](https://github.com/zensgit/metasheet2/actions/runs/21946247688)
- Evidence:
  - `output/playwright/ga/21946247688/attendance-import-perf-21946247688-1/attendance-perf-mljfazcf-oeeupe/perf-summary.json`
- previewMs: `17167`
- commitMs: `594239`
- rollbackMs: `7192`

## Notes / Follow-Up (P1)

The above changes close the original response-size and synchronous-preview gaps and add large-scope safety caps. Remaining work for very large payloads (100k+) is:

- COPY-based fast path / staging-table commit pipeline to further reduce latency variance.
- richer async preview paging UX for very large datasets (multi-page preview browsing).
- explicit timeout + retry policy tuning (nginx + backend) for long-running imports under load.

For the recommended next-stage plan for `300k-500k+` rows, see:

- `docs/attendance-production-import-extreme-scale-plan-20260212.md`
