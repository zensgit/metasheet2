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

## Notes / Follow-Up (P1)

The above changes prevent response-size failures. The remaining work for truly large payloads (50k-100k) is:

- async/streaming preview + commit (job model + polling + paging)
- bulk upserts (reduce per-row DB work) with consistent locking strategy
- explicit timeout + retry strategy (nginx + backend) for long commits
