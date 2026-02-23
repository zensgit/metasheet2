# Attendance Production Closure Report (2026-02-21)

## Scope

- Close current production-hardening cycle for Attendance v1 (excluding Payroll/CAD).
- Deliver stable strict/perf/dashboard gates and finalize import API operational metrics.

## Delivered In This Cycle

1. Gate stabilization
- Strict gate retries hardened across API/Playwright/provision scripts.
- Perf baseline defaults aligned to production-safe path (`commitAsync=false`, `uploadCsv=true`).
- Daily dashboard remains PASS with strict/perf/branch-protection/storage/metrics visibility.
- Branch protection policy upgraded to require PR reviews (`min_approving_review_count=1`) while keeping `require_code_owner_reviews=false` for current phase.

2. Import API operational metrics contract
- `POST /api/attendance/import/commit` returns:
  - `engine` (`standard|bulk`)
  - `processedRows`
  - `failedRows`
  - `elapsedMs`
- `GET /api/attendance/import/jobs/:id` returns:
  - `engine` (`standard|bulk`)
  - `processedRows`
  - `failedRows`
  - `elapsedMs`
- Async commit jobs retain a compact `commitResult` payload summary after completion.

3. Frontend operator visibility
- Admin import async status panel now displays:
  - `engine`
  - processed progress based on `processedRows` fallback logic
  - `failedRows`
  - human-readable elapsed time
- File:
  - `apps/web/src/views/AttendanceView.vue`

4. Tooling + tests
- Perf harness now writes `importEngine`, `processedRows`, `failedRows`, `elapsedMs` in `perf-summary.json`.
- Integration tests assert new fields in sync commit and async job polling paths.

## Verification Evidence

| Item | Run / Command | Result | Evidence |
|---|---|---|---|
| Strict Gates (Prod) | [#22257658383](https://github.com/zensgit/metasheet2/actions/runs/22257658383) | PASS | `output/playwright/ga/22257658383/attendance-strict-gates-prod-22257658383-1/` |
| Perf Long Run | [#22257658595](https://github.com/zensgit/metasheet2/actions/runs/22257658595) | PASS | `output/playwright/ga/22257658595/attendance-import-perf-longrun-rows10k-commit-22257658595-1/` |
| Perf Baseline | [#22257956044](https://github.com/zensgit/metasheet2/actions/runs/22257956044) | PASS | `output/playwright/ga/22257956044/attendance-import-perf-22257956044-1/` |
| Daily Dashboard | [#22257991561](https://github.com/zensgit/metasheet2/actions/runs/22257991561) | PASS | `output/playwright/ga/22257991561/attendance-daily-gate-dashboard-22257991561-1/` |
| Backend integration tests | `pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts` | PASS (`14 passed`) | local test output |
| Web build/typecheck | `pnpm --filter @metasheet/web build` | PASS | local build output |

Key log checks:
- Strict API smoke contains `import upload ok`, `idempotency ok`, `export csv ok`, `SMOKE PASS`.
- Perf baseline summary contains `commitAsync=false`, `uploadCsv=true`, `regressions=[]`.
- Daily dashboard reports `P0 Status: PASS`, `Overall: PASS`.

## Current Production Decision

- Status: **GO**
- Reason:
  - P0 strict gates are stable.
  - Upload channel is covered in strict/perf paths.
  - No open Attendance P0/P1 blocking issue.

## Follow-up Backlog (Next Phase)

1. 100k+/500k import engine hardening:
- Introduce true bulk path implementation (COPY/staging) behind controlled rollout.
- Keep `engine=bulk` semantics tied to actual execution mode (not only threshold classification).

2. Frontend operational UX:
- Normalize import/retry/recovery UX in Admin Center and Overview.
- Add user-facing error taxonomy and one-click remediation actions.

3. Continuous operations:
- Keep nightly strict/perf/dashboard audits and archive artifacts for trend analysis.

## Security Note

- This report intentionally contains no live token/secret values.
- Use placeholders in commands (for example `<ADMIN_JWT>`).

## Update (2026-02-22): Post-Merge Gate Refresh

After PR [#224](https://github.com/zensgit/metasheet2/pull/224) merged, gates were re-run on `main` with review policy enforcement enabled.

| Gate | Run | Status | Evidence |
|---|---|---|---|
| Branch Policy Drift drill | [#22267999575](https://github.com/zensgit/metasheet2/actions/runs/22267999575) | FAIL (expected) | `output/playwright/ga/22267999575/attendance-branch-policy-drift-prod-22267999575-1/step-summary.md` |
| Branch Policy Drift recovery | [#22268010766](https://github.com/zensgit/metasheet2/actions/runs/22268010766) | PASS | `output/playwright/ga/22268010766/attendance-branch-policy-drift-prod-22268010766-1/policy.json` |
| Branch Protection parity | [#22268146870](https://github.com/zensgit/metasheet2/actions/runs/22268146870) | PASS | `output/playwright/ga/22268146870/attendance-branch-protection-prod-22268146870-1/step-summary.md` |
| Strict Gates | [#22268021574](https://github.com/zensgit/metasheet2/actions/runs/22268021574) | PASS | `output/playwright/ga/22268021574/attendance-strict-gates-prod-22268021574-1/20260222-012647-1/gate-summary.json` |
| Perf Baseline | [#22268076603](https://github.com/zensgit/metasheet2/actions/runs/22268076603) | PASS | `output/playwright/ga/22268076603/attendance-import-perf-22268076603-1/attendance-perf-mlx2lyp8-at17vk/perf-summary.json` |
| Perf Long Run | [#22268111924](https://github.com/zensgit/metasheet2/actions/runs/22268111924) | PASS | `output/playwright/ga/22268111924/attendance-import-perf-longrun-rows10k-commit-22268111924-1/current-flat/rows10000-commit.json` |
| Daily Dashboard | [#22268136099](https://github.com/zensgit/metasheet2/actions/runs/22268136099) | PASS | `output/playwright/ga/22268136099/attendance-daily-gate-dashboard-22268136099-1/attendance-daily-gate-dashboard.json` |

## Update (2026-02-23): Bulk Path Chunking Hardening (B-line)

Scope:

- Ensure import `engine` classification (`standard|bulk`) drives real execution knobs, not only response labels.
- Persist chunk strategy in batch metadata for post-incident auditability.
- Improve import failure recovery UX in Admin Center with CSV upload-specific guidance/actions.

Code updates:

- `plugins/plugin-attendance/index.cjs`
  - Added env knobs:
    - `ATTENDANCE_IMPORT_BULK_ITEMS_CHUNK_SIZE` (default `1200`)
    - `ATTENDANCE_IMPORT_BULK_RECORDS_CHUNK_SIZE` (default `1000`)
    - `ATTENDANCE_IMPORT_BULK_ENGINE_MODE` (`auto|force|off`, default `auto`)
  - Added `resolveImportChunkConfig(engine)` and wired it into:
    - async commit processor (`processAsyncImportCommitJob`)
    - sync commit endpoint (`POST /api/attendance/import/commit`)
  - `batchMeta` now persists `chunkConfig` with the resolved chunk sizes.
  - Import job API (`GET /api/attendance/import/jobs/:id`) now returns `chunkConfig` for async polling visibility.

- `packages/core-backend/tests/integration/attendance-plugin.test.ts`
  - Import commit integration test now validates `meta.chunkConfig` and matches it to the returned `engine`:
    - `standard` -> standard chunk env/fallback
    - `bulk` -> bulk chunk env/fallback

- `scripts/ops/attendance-import-perf.mjs`
  - `perf-summary.json` now records `chunkConfig.itemsChunkSize` and `chunkConfig.recordsChunkSize`.
  - Perf run fetches batch detail metadata (`/attendance/import/batches/:id`) to align summary with actual committed batch config.

- `scripts/ops/attendance-import-perf-trend-report.mjs`
  - Trend summary now includes `Chunk` column (`items/records`) for latest scenario sample.

- `apps/web/src/views/AttendanceView.vue`
  - Added import error taxonomy for CSV upload path:
    - `EXPIRED`, `INVALID_CSV_FILE_ID`, `CSV_TOO_LARGE`, `PAYLOAD_TOO_LARGE` (HTTP `413`)
  - Added status action `Re-apply CSV` (`reload-import-csv`) to recover preview/import failures without page reload.
  - Added import batch table visibility:
    - `Engine` column (`standard|bulk`)
    - `Chunk` column (`itemsChunkSize/recordsChunkSize`) from `batch.meta.chunkConfig`

Local verification:

| Item | Command | Result |
|---|---|---|
| Plugin syntax | `node --check plugins/plugin-attendance/index.cjs` | PASS |
| Perf scripts syntax | `node --check scripts/ops/attendance-import-perf.mjs && node --check scripts/ops/attendance-import-perf-trend-report.mjs` | PASS |
| Attendance integration suite | `pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts` | PASS (`14 passed`) |
| Web build | `pnpm --filter @metasheet/web build` | PASS |

Notes:

- This update is backward-compatible for API consumers; no existing response fields were removed.
- Remaining next step for B-line is true staging/COPY execution for 100k+ imports (separate milestone).
