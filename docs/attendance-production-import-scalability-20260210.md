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

## Notes / Follow-Up (P1)

The above changes prevent response-size failures. The remaining work for truly large payloads (50k-100k) is:

- async/streaming preview (job model + polling + paging). Commit is now supported via `commit-async`, but preview is still synchronous.
- bulk upserts (reduce per-row DB work) with consistent locking strategy
- explicit timeout + retry strategy (nginx + backend) for long commits
