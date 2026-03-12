# Attendance Parallel Development Report (Round24, 2026-03-12)

## Scope

A-line + B-line convergence hardening:

1. integrate `Perf High Scale` into daily gate dashboard (P2).
2. prevent false stale alarms for weekly high-scale lane.
3. keep dashboard JSON contract validator aligned with new gate.

## Implementation

### 1) Daily dashboard integration for high-scale lane

Updated:

- `scripts/ops/attendance-daily-gate-report.mjs`
- `.github/workflows/attendance-daily-gate-dashboard.yml`

Changes:

- added workflow env support:
  - `HIGHSCALE_WORKFLOW` (default `attendance-import-perf-highscale.yml`)
- added dashboard gate:
  - `Perf High Scale` with severity `P2`
- added dedicated lookback policy:
  - `highscaleLookbackHours = max(lookbackHours, 240)`
- integrated high-scale gate into:
  - Gate Status table
  - Artifact Download Commands
  - Findings/Remediation hints
  - Suggested Actions + quick rerun commands
  - `gateFlat` + `gates` JSON payload

### 2) Dashboard contract alignment

Updated:

- `scripts/ops/attendance-validate-daily-dashboard-json.sh`

Changes:

- keep existing required checks for `perf` + `longrun`.
- add conditional validation for `highscale` when present:
  - `validate_perf_like_gate "highscale" "Perf High Scale"`
- preserves backward compatibility for older fixture JSON that does not include `gateFlat.highscale`.

## Local Verification

| Check | Command | Status | Evidence |
|---|---|---|---|
| Daily report/parser tests + fast regression + highscale runner tests | `node --test scripts/ops/attendance-daily-gate-report.test.mjs scripts/ops/attendance-fast-parallel-regression.test.mjs scripts/ops/attendance-run-perf-highscale.test.mjs` | PASS | stdout (20/20) |
| Dashboard validator shell syntax | `bash -n scripts/ops/attendance-validate-daily-dashboard-json.sh` | PASS | stdout |
| High-scale runner shell syntax | `bash -n scripts/ops/attendance-run-perf-highscale.sh` | PASS | stdout |
| Dashboard JSON contract fixtures | `scripts/ops/attendance-run-gate-contract-case.sh dashboard output/playwright/attendance-gate-contract-matrix` | PASS | expected-fail subcases confirmed + final PASS |
| Dashboard report replay (main, highscale workflow not yet on remote default branch before merge) | `GH_TOKEN="$(gh auth token)" BRANCH=main LOOKBACK_HOURS=48 node scripts/ops/attendance-daily-gate-report.mjs` | PASS (script) / overall FAIL expected | `output/playwright/attendance-daily-gate-dashboard/20260312-005245/` (`WORKFLOW_QUERY_FAILED` for highscale as expected pre-merge) |
| Dashboard report replay (compat override for local contract rendering) | `GH_TOKEN="$(gh auth token)" BRANCH=main LOOKBACK_HOURS=48 HIGHSCALE_WORKFLOW=attendance-import-perf-longrun.yml node scripts/ops/attendance-daily-gate-report.mjs` | PASS | `output/playwright/attendance-daily-gate-dashboard/20260312-005458/` |
| Daily dashboard JSON validator on replay output | `./scripts/ops/attendance-validate-daily-dashboard-json.sh output/playwright/attendance-daily-gate-dashboard/20260312-005458/attendance-daily-gate-dashboard.json` | PASS | stdout (`schemaVersion=4`, `overallStatus=pass`) |

## Evidence Paths

- `output/playwright/attendance-daily-gate-dashboard/20260312-005245/attendance-daily-gate-dashboard.md`
- `output/playwright/attendance-daily-gate-dashboard/20260312-005245/attendance-daily-gate-dashboard.json`
- `output/playwright/attendance-daily-gate-dashboard/20260312-005458/attendance-daily-gate-dashboard.md`
- `output/playwright/attendance-daily-gate-dashboard/20260312-005458/attendance-daily-gate-dashboard.json`
- `output/playwright/attendance-gate-contract-matrix/dashboard/`

## Post-Merge Mandatory GA Verification

1. Run high-scale workflow on `main`:

```bash
gh workflow run attendance-import-perf-highscale.yml -f drill=false -f upload_csv=true
```

2. Run daily dashboard on `main` and confirm `Perf High Scale` row appears with workflow `attendance-import-perf-highscale.yml`.

```bash
gh workflow run attendance-daily-gate-dashboard.yml -f branch=main -f lookback_hours=48
```

3. Download artifacts and append run IDs to Go/No-Go.

```bash
RUN_ID="<RUN_ID>"
gh run download "${RUN_ID}" -D "output/playwright/ga/${RUN_ID}"
```

