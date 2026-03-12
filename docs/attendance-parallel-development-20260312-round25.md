# Attendance Parallel Development Report (Round25, 2026-03-12)

## Scope

Parallel closure for gate-chain completeness:

1. add `Perf High Scale` into post-merge verification flow.
2. add dashboard contract negative case for `gateFlat.highscale`.
3. expand fast parallel regression ops profile to include highscale runner tests.

## Implementation

### 1) Post-merge verify includes highscale lane

Updated:

- `scripts/ops/attendance-post-merge-verify.sh`

Changes:

- new skip switch:
  - `SKIP_PERF_HIGHSCALE` (default `false`)
- new highscale dispatch inputs:
  - `PERF_HIGHSCALE_*` (rows/mode/preview/commit/upload/payload/timeout/threshold)
- new local contract checks:
  - `run_perf_highscale_contract_gate()`
  - result row: `perf-highscale-contract`
- post-merge chain now runs:
  - `attendance-import-perf-highscale.yml`
  - then validates downloaded `perf-summary.json` contract.

### 2) Dashboard contract matrix adds highscale negative coverage

Updated:

- `scripts/ops/attendance-run-gate-contract-case.sh`

Changes:

- `dashboard.valid.json` now includes `gates.highscale` + `gateFlat.highscale`.
- new invalid fixture:
  - `dashboard.invalid.highscale.json`
  - invalid `gateFlat.highscale.uploadCsv="maybe"` (expected contract failure).
- dashboard contract case now asserts expected fail:
  - `dashboard highscale gateFlat contract`.

### 3) Fast parallel regression includes highscale runner tests

Updated:

- `scripts/ops/attendance-fast-parallel-regression.sh`
- `scripts/ops/attendance-fast-parallel-regression.test.mjs`

Changes:

- `PROFILE=ops|full` now includes:
  - `ops-perf-highscale-runner-tests` (`node --test scripts/ops/attendance-run-perf-highscale.test.mjs`)
- test expectation adjusted:
  - ops profile total checks `4 -> 5`.

## Verification

| Check | Command | Status | Evidence |
|---|---|---|---|
| Post-merge verify syntax | `bash -n scripts/ops/attendance-post-merge-verify.sh` | PASS | stdout |
| Contract-case syntax | `bash -n scripts/ops/attendance-run-gate-contract-case.sh` | PASS | stdout |
| Dashboard contract matrix (incl. highscale negative case) | `scripts/ops/attendance-run-gate-contract-case.sh dashboard output/playwright/attendance-gate-contract-matrix` | PASS | `output/playwright/attendance-gate-contract-matrix/dashboard/` |
| Fast regression tests | `pnpm verify:attendance-regression-fast:test` | PASS | stdout (4/4) |
| Highscale runner tests | `pnpm verify:attendance-perf-highscale:test` | PASS | stdout (2/2) |
| Daily report parser tests | `node --test scripts/ops/attendance-daily-gate-report.test.mjs` | PASS | stdout (14/14) |

## Evidence Paths

- `output/playwright/attendance-gate-contract-matrix/dashboard/`
- `output/playwright/attendance-daily-gate-dashboard/20260312-005458/`

## Next (main branch after merge)

1. run post-merge verify once with highscale enabled:

```bash
SKIP_PERF_HIGHSCALE=false bash scripts/ops/attendance-post-merge-verify.sh
```

2. confirm summary contains:
   - `perf-highscale`
   - `perf-highscale-contract`

3. append runId/evidence into Go/No-Go MD.

