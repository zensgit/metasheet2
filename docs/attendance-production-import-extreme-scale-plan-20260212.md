# Attendance Import Extreme Scale Plan (2026-02-12)

This document defines the next-stage work required to keep attendance imports stable for **extreme payloads** (roughly `300k-500k+` rows).

For baseline scalability work up to `100k` rows (async commit + rollback), see:

- `docs/attendance-production-import-scalability-20260210.md`

## Current Baseline (100k)

Latest `100k` run (commit-async + rollback, export disabled):

- Run: [Attendance Import Perf Baseline #21941478702](https://github.com/zensgit/metasheet2/actions/runs/21941478702) (`SUCCESS`)
- Evidence:
  - `output/playwright/ga/21941478702/attendance-import-perf-21941478702-1/attendance-perf-mlj9y3ri-a801np/perf-summary.json`
- previewMs: `6657`
- commitMs: `257121`
- rollbackMs: `1118`

## Current Baseline (200k)

Latest `200k` run (commit-async + rollback, export disabled):

- Run: [Attendance Import Perf Baseline #21944618100](https://github.com/zensgit/metasheet2/actions/runs/21944618100) (`SUCCESS`)
- Evidence:
  - `output/playwright/ga/21944618100/attendance-import-perf-21944618100-1/attendance-perf-mljdfef2-ithiuu/perf-summary.json`
- previewMs: `10086`
- commitMs: `232725`
- rollbackMs: `1874`

Notes:

- This run overrides `max_commit_ms=900000` to avoid treating expected extreme-payload latency as a regression.
- Perf improvement (same env, 200k commit-async):
  - Before caching Intl formatters: commitMs `566193` (run `#21943641804`)
  - After caching Intl formatters: commitMs `232725` (run `#21944618100`)
- `200k` rows require a larger JSON body limit for `/api/attendance/import/*` because `csvText` is sent inside JSON:
  - Global JSON limit remains `10mb` (DoS guard).
  - Per-route override: `ATTENDANCE_IMPORT_JSON_LIMIT` (default `50mb`).
  - Reverse proxy must allow the same or higher body size (nginx `client_max_body_size 50m`).

## Current Baseline (300k)

Latest `300k` run (commit-async + rollback, export disabled):

- Run: [Attendance Import Perf Baseline #21944960433](https://github.com/zensgit/metasheet2/actions/runs/21944960433) (`SUCCESS`)
- Evidence:
  - `output/playwright/ga/21944960433/attendance-import-perf-21944960433-1/attendance-perf-mljdtnov-wh6efv/perf-summary.json`
- previewMs: `13965`
- commitMs: `350509`
- rollbackMs: `4451`

Notes:

- This run overrides `max_commit_ms=1200000` to avoid treating expected extreme-payload latency as a regression.

## Current Baseline (500k)

Latest `500k` run (commit-async + rollback, export disabled):

- Run: [Attendance Import Perf Baseline #21946247688](https://github.com/zensgit/metasheet2/actions/runs/21946247688) (`SUCCESS`)
- Evidence:
  - `output/playwright/ga/21946247688/attendance-import-perf-21946247688-1/attendance-perf-mljfazcf-oeeupe/perf-summary.json`
- previewMs: `17167`
- commitMs: `594239`
- rollbackMs: `7192`

Notes:

- This run overrides `max_commit_ms=1800000` to avoid treating expected extreme-payload latency as a regression.
- At `500k`, the payload approaches the default CSV row cap (`ATTENDANCE_IMPORT_CSV_MAX_ROWS=500000`) and the reverse proxy body limit (`client_max_body_size 50m`).

Latest `500k` run (commit-async + rollback, export enabled):

- Run: [Attendance Import Perf Baseline #21946763144](https://github.com/zensgit/metasheet2/actions/runs/21946763144) (`SUCCESS`)
- Evidence:
  - `output/playwright/ga/21946763144/attendance-perf-mljfw881-6fyhbk/perf-summary.json`
- previewMs: `22687`
- commitMs: `627089`
- exportMs: `16627`
- rollbackMs: `6877`

Latest `500k` run (commit-async + rollback, export enabled, upload_csv enabled):

- Run: [Attendance Import Perf Baseline #21948416024](https://github.com/zensgit/metasheet2/actions/runs/21948416024) (`SUCCESS`)
- Evidence:
  - `output/playwright/ga/21948416024/attendance-perf-mljhqv6r-wx77vt/perf-summary.json`
- previewMs: `16290`
- commitMs: `463804`
- exportMs: `14491`
- rollbackMs: `6566`

Notes:

- This run uses the CSV upload channel (`POST /api/attendance/import/upload` + `csvFileId`) to avoid embedding `csvText` in JSON.
- It validates end-to-end: upload -> preview -> commit-async -> export.csv -> rollback.

## When This Becomes Necessary

We should prioritize the work below if any of these become true:

- imports routinely exceed `300k` rows (or a single import can exceed `500k`)
- async commit jobs approach timeout (`~30min`) under normal load
- DB shows sustained high CPU due to SQL parse/plan overhead (lots of short multi-row statements)

## Proposed Work (Recommended Order)

### 1) Replace record UPSERT VALUES(...) with UNNEST arrays (no new deps)

Current implementation (`batchUpsertAttendanceRecords`) emits `VALUES ($1...$N)` with `13 * chunkSize` placeholders.
For large workloads, the statement size and placeholder count can add measurable parse/plan overhead.

Proposal:

- Change the record UPSERT to:
  - pass `text[]/date[]/timestamptz[]/int[]/boolean[]/jsonb[]/uuid[]` arrays as params
  - `INSERT ... SELECT ... FROM unnest(...)` instead of expanding many placeholders
- Keep behavior identical:
  - same chunk sizes
  - same `merge/override` semantics computed in JS
  - same `RETURNING id, user_id, work_date` mapping

Rollout:

- Feature gate via env:
  - `ATTENDANCE_IMPORT_RECORD_UPSERT_MODE=values|unnest|staging`
  - default `unnest` (shipped; set `values` to revert)

Validation:

- Existing integration suite (includes merge-mode semantics test)
- Perf:
  - `10k` baseline must not regress
  - one-off `100k` run on demand for confidence

Status (2026-02-12):

- Shipped in `91c21cab` and validated:
  - strict gates: [Attendance Strict Gates (Prod) #21941278046](https://github.com/zensgit/metasheet2/actions/runs/21941278046)
  - perf 10k: [Attendance Import Perf Baseline #21941424853](https://github.com/zensgit/metasheet2/actions/runs/21941424853)
  - perf 100k: [Attendance Import Perf Baseline #21941478702](https://github.com/zensgit/metasheet2/actions/runs/21941478702)

### 2) Bulk insert attendance_import_items via UNNEST arrays (no new deps)

On large commits, `attendance_import_items` is usually the largest write volume. This can be optimized similarly:

- replace multi-row VALUES(...) inserts with an `unnest(...)`-based INSERT per chunk
- keep export semantics and rollback behavior unchanged

Validation:

- strict gates (2x) must still pass (export CSV relies on import items)
- perf baseline should show reduced commit time variance

Status (2026-02-12):

- Shipped in `91c21cab` under:
  - `ATTENDANCE_IMPORT_ITEMS_INSERT_MODE=values|unnest` (default `unnest`)

### 3) COPY-based fast path via temp/staging table (optional; 500k+ only)

If `500k+` imports become common, the next leap is a streaming ingest path:

1. Stream computed rows into a temp table via `COPY FROM STDIN`.
2. Execute set-based:
   - `INSERT INTO attendance_records (...) SELECT ... FROM temp ... ON CONFLICT (...) DO UPDATE ...`
3. Insert import items in bulk (either via COPY or unnest insert).

Notes:

- This does not require moving `computeMetrics()` into SQL.
  We would stage **already-computed** columns (first/last timestamps, minutes, status, meta, sourceBatchId).
- Implementation depends on access to a raw `pg` client:
  - easiest via `pg-copy-streams` (new dependency)
  - requires the plugin runtime to expose the underlying `pg` client/connection for COPY streams

Rollout:

- Keep this path behind a threshold + explicit enable switch:
  - `ATTENDANCE_IMPORT_COPY_ENABLED=true|false` (default `true`)
  - `ATTENDANCE_IMPORT_COPY_THRESHOLD_ROWS=50000` (default)
- Fallback to the non-COPY path when COPY cannot be used.

Validation:

- Add a dedicated perf workflow for `200k+` (manual trigger only).
- Keep strict gates unchanged (still run daily).

Status (2026-02-23):

- Shipped **staging-table auto-switch** (no new dependency) for large imports:
  - selects `recordUpsertStrategy=staging` for bulk imports at/above threshold.
  - exposes strategy in commit/job telemetry and perf summaries.
- Native streaming `COPY FROM STDIN` remains optional future optimization for `500k+` heavy traffic.

## Risks / Open Questions

- COPY plumbing: plugin runtime currently uses `db.query(...)` style helpers; may not expose COPY streams.
- Transaction boundaries: COPY + final upsert should be within a single transaction for correctness.
- DB locking contention: very large imports can hold row locks longer; async job should remain the default.
- Evidence discipline: perf artifacts must not include tokens/secrets; only store local paths and GA run links.
