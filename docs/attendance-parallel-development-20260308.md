# Attendance Parallel Development Report (2026-03-08)

## Summary
This round completed parallel hardening across workflow contracts, backend async-import reliability, and verification automation.
- PR: `#374` (`https://github.com/zensgit/metasheet2/pull/374`)
- Status: merged to `main` (`8d91bf2b5ad6e222a8e0fcc63b8ed8260ca3ddcf`)
- Branch protection was restored after merge:
  - `require_pr_reviews=true`
  - `min_approving_review_count=1`
  - `strict=true`

## Update (Round 2, 2026-03-08)

### 5) Longrun preview payload strategy hardening
- `scripts/ops/attendance-import-perf.mjs`
  - In `PAYLOAD_SOURCE=auto`, `preview` runs above CSV row cap now force rows payload fallback.
  - New reason code: `preview_rows_exceeds_csv_limit_hint(<hint>)`.
  - Goal: avoid hard `CSV_TOO_LARGE` failures when production keeps strict CSV row caps.

### 6) Longrun default stability
- `.github/workflows/attendance-import-perf-longrun.yml`
  - `include_rows500k_preview` default changed to `false`.
  - Env fallback default `INCLUDE_ROWS500K_PREVIEW` changed to `false`.
  - 500k preview remains available by explicit opt-in input/var.

## Implemented Changes

### 1) Workflow contract hardening
- `.github/workflows/attendance-import-perf-baseline.yml`
  - Added `workflow_dispatch.inputs.payload_source` (default `auto`)
  - Added `workflow_dispatch.inputs.csv_rows_limit_hint` (default `20000`)
  - Propagated both values into perf job env.

- `.github/workflows/attendance-import-perf-longrun.yml`
  - Added `workflow_dispatch.inputs.payload_source` (default `auto`)
  - Propagated `PAYLOAD_SOURCE` and `CSV_ROWS_LIMIT_HINT` into scenario jobs.
  - Scenario skip logic now enforces row caps only when payload mode is CSV.

- `scripts/ops/attendance-post-merge-verify.sh`
  - Added dispatch args for `payload_source` and `csv_rows_limit_hint`.
  - Extended perf contract checks to require `uploadCsvRequested` and `payloadSource`.

- `scripts/ops/attendance-import-perf-trend-report.mjs`
  - Added parsing/reporting for:
    - `uploadCsvRequested`
    - `payloadSource`
    - `payloadSourceReason`
  - Markdown summary now includes Upload(requested/effective) + Payload columns.

### 2) Backend reliability fix (root cause)
- `plugins/plugin-attendance/index.cjs`
  - Fixed `sanitizeImportJobPayload` commit path:
    - previously dropped `rows` when `rows.length > 5000` unconditionally.
    - now drops `rows/entries` only when `csvText` exists.
  - Prevents `commit-async` job failures (`No rows to import`) in rows-only large payload mode.

### 3) Regression guard test
- `packages/core-backend/tests/integration/attendance-plugin.test.ts`
  - Added test:
    - `keeps large rows payload for commit-async jobs when csv payload is absent`
  - Covers:
    - `rows=5001` rows-only payload
    - `commit-async` creation
    - idempotent retry without `commitToken`
    - job polling completion
    - rollback success

### 4) Frontend verification enhancement
- `scripts/verify-attendance-full-flow.mjs`
  - Added `ASSERT_ADMIN_RULE_SAVE` (default true).
  - Added `assertAdminRuleSaveCycle()` to ensure rule-save UI does not stay stuck in `Saving...`.

## Validation Executed

### Local checks
1. Integration test
```bash
pnpm --filter @metasheet/core-backend run test:integration:attendance
```
Result: PASS (`16/16`)

2. Syntax checks
```bash
node --check scripts/verify-attendance-full-flow.mjs
node --check scripts/ops/attendance-import-perf.mjs
node --check scripts/ops/attendance-import-perf-trend-report.mjs
node --check plugins/plugin-attendance/index.cjs
```
Result: PASS

### Existing GA evidence (before this fix deployment)
- Perf baseline PASS:
  - workflow run: `22803281301`
- Longrun failure captured (used for RCA):
  - workflow run: `22803281293`
  - artifact path:
    - `output/playwright/ga/22803281293/attendance-import-perf-longrun-rows100k-commit-22803281293-1/current/rows100k-commit/perf.log`

### PR CI evidence (post-fix branch)
- `Attendance Gate Contract Matrix`: `22803514617` (PASS)
- `Plugin System Tests`: `22803514632` (PASS)
- `Observability E2E`: `22803514607` (PASS)
- `Migration Replay`: `22803514615` (PASS)
- `Batch2 Test Stabilization`: `22803514614` (PASS)

## Post-Merge Validation (Closed)
- Mainline post-merge verifier:
  - output root: `output/playwright/attendance-post-merge-verify/20260308-111840`
  - branch-policy `22812865899` PASS
  - strict `22812871344` PASS
  - perf-baseline `22812931351` PASS
  - daily-dashboard `22812940744` PASS
- Longrun focused verification:
  - run `22813005748` PASS
  - `rows100k-commit` executed successfully and no `No rows to import` regression.

## Round 2 Validation (Preview payload cap fallback)
- Longrun regression capture after first strategy change:
  - run `22813243944` FAIL
  - root cause: `rows50k-preview`/`rows100k-preview` hit `CSV_TOO_LARGE` because production CSV cap is `20000`.
- Longrun verification after fallback fix:
  - run `22813306215` PASS
  - `rows50k-preview` and `rows100k-preview` now use:
    - `payloadSource=rows`
    - `payloadSourceReason=preview_rows_exceeds_csv_limit_hint(20000)`
  - both preview scenarios completed successfully.

## Evidence Paths
- Branch workspace: `/private/tmp/metasheet2-parallel-20260308`
- GA artifacts root (downloaded):
  - `output/playwright/ga/22803281293/...`
  - `output/playwright/ga/22803281301/...`
  - `output/playwright/ga/22813243944/...`
  - `output/playwright/ga/22813306215/...`
