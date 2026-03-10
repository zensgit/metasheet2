# Attendance Parallel Development Report (Round18, 2026-03-10)

## Scope

Round18 continued the gate-ops acceleration track on top of PR #396 with three goals:

1. make the local fast regression runner lane-aware for parallel A/B/C delivery.
2. make artifacts collision-safe under concurrent runs.
3. promote `summary.json` from human-only output to structured machine-consumable metadata.

## Implementation

### 1) Lane-aware fast regression runner

- Updated `scripts/ops/attendance-fast-parallel-regression.sh`:
  - new `PROFILE` selector:
    - `full` (ops + contracts)
    - `ops` (ops-only by default)
    - `contracts` (contract-only)
  - new `MAX_PARALLEL` cap to control local concurrency.
  - `RUN_CONTRACT_CASES` now defaults by profile (`ops=false`, otherwise `true`), while still allowing explicit override.

### 2) Concurrent-run artifact collision fix

- Updated default timestamp key from second-level only to `timestamp + pid`:
  - before: `20260309-172120`
  - after: `20260310-075225-24644`
- This removes same-second output root collisions when running multiple fast lanes concurrently.

### 3) Summary metadata contract

- `summary.json` now includes:
  - `profile`
  - `maxParallel`
  - `runContractCases`
  - existing `timestamp`, `outputRoot`, `totals`, `checks` retained.

### 4) Regression tests + command shortcuts

- Added `scripts/ops/attendance-fast-parallel-regression.test.mjs`:
  - invalid profile rejected.
  - invalid max parallel rejected.
  - `PROFILE=ops` defaults to ops-only checks.
  - `PROFILE=contracts` defaults to contract-only checks.
- Added package scripts in `package.json`:
  - `pnpm verify:attendance-regression-fast`
  - `pnpm verify:attendance-regression-fast:test`
  - `pnpm verify:attendance-regression-fast:ops`
  - `pnpm verify:attendance-regression-fast:contracts`

### 5) Lane summary report utility (new)

- Added `scripts/ops/attendance-fast-parallel-summary-report.mjs`:
  - consumes fast regression `summary.json` files.
  - outputs one Markdown lane-health table + JSON payload.
  - defaults to latest row per profile (`full/ops/contracts`) while preserving an all-rows mode (`LATEST_PER_PROFILE=false`).
  - backward-compatible inference for older summaries without metadata (`profile/maxParallel/runContractCases`).
- Added `scripts/ops/attendance-fast-parallel-summary-report.test.mjs` (4 tests).
- Added package scripts:
  - `pnpm verify:attendance-regression-fast:report`
  - `pnpm verify:attendance-regression-fast:report:test`

## Verification

| Check | Command | Status | Evidence |
|---|---|---|---|
| Fast runner profile tests | `pnpm verify:attendance-regression-fast:test` | PASS | node test stdout |
| Full lane run | `pnpm verify:attendance-regression-fast` | PASS | `output/playwright/attendance-fast-parallel-regression/20260310-075225-24644/summary.md` |
| Ops lane run | `pnpm verify:attendance-regression-fast:ops` | PASS | `output/playwright/attendance-fast-parallel-regression/20260309-172147-94804/summary.json` |
| Contracts lane run | `pnpm verify:attendance-regression-fast:contracts` | PASS | `output/playwright/attendance-fast-parallel-regression/20260309-172147-94807/summary.json` |
| Summary metadata probe | `jq '.profile,.maxParallel,.runContractCases,.totals.total' output/playwright/attendance-fast-parallel-regression/20260310-075225-24644/summary.json` | PASS | values: `\"full\"`, `6`, `true`, `6` |
| Lane summary report tests | `pnpm verify:attendance-regression-fast:report:test` | PASS | node test stdout |
| Lane summary report generation | `pnpm verify:attendance-regression-fast:report` | PASS | `output/playwright/attendance-fast-parallel-report/20260309-235920/attendance-fast-parallel-report.md`, `output/playwright/attendance-fast-parallel-report/20260309-235920/attendance-fast-parallel-report.json` |

## Branch / PR Status

- Branch: `codex/attendance-parallel-round17`
- PR: `https://github.com/zensgit/metasheet2/pull/396`
- Latest head in this round: `17a2c6db`
- Required checks: PASS on latest head
- Current blocker: `REVIEW_REQUIRED` (repository policy requires at least one approving review by write user)

## Commits (Round18)

1. `2696fa0b` feat(ops): add lane profiles for fast attendance regression
2. `d54051ca` test(ops): cover fast attendance regression lane profiles
3. `4077520b` docs(attendance): update round17 commit log and profile evidence
4. `02a9855b` feat(ops): export fast regression profile metadata in summaries
5. `17a2c6db` docs(attendance): track latest round17 metadata export commit
6. `29f2ad0b` docs(attendance): add round18 parallel development and verification report
7. `86226304` feat(ops): add fast regression lane summary reporter
8. `4ddee5b7` test(ops): cover legacy metadata inference in lane reporter

## Next Parallel Wave

1. A-line (Gate Ops): merge PR #396 after approval, then run one mainline post-merge chain to bind new metadata contract to `main` evidence.
2. B-line (Import Perf): add a small parser utility that consumes `summary.json` (`profile/maxParallel/runContractCases`) and emits a compact lane-health table for PR comments.
3. C-line (UI/QA): keep bilingual smoke and workflow-attendance contracts green; only consume the new fast-runner outputs, no behavior change in runtime UI.
