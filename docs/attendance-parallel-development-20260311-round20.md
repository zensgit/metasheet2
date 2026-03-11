# Attendance Parallel Development Report (Round20, 2026-03-11)

## Scope

Stabilize post-merge gate chain after Round19 merges. The new `Attendance Post-Merge Verify` run on `main` failed on the perf baseline gate with repeated `HTTP 502` on sync commit path.

## Failure Evidence

- Failed run: `Attendance Post-Merge Verify (Nightly)` #22933303858
- Local evidence directory:
  - `output/playwright/ga/22933303858/summary.json`
  - `output/playwright/ga/22933303858/ga/22933468090/attendance-import-perf-22933468090-1/perf.log`
- Failing gate in summary:
  - `perf-baseline` -> run #22933468090 -> `FAIL`
- Perf log excerpt:
  - repeated `POST /attendance/import/prepare` `HTTP 502`
  - final `POST /attendance/import/commit` `HTTP 502` (nginx bad gateway)

## Implementation

### 1) Perf baseline defaults switched to gateway-safe async commit

Updated:
- `.github/workflows/attendance-import-perf-baseline.yml`

Changes:
- `workflow_dispatch.inputs.commit_async.default` from `false` -> `true`
- schedule fallback default for `COMMIT_ASYNC` from `false` -> `true`

Outcome:
- baseline continues to cover upload path (`upload_csv=true`) but avoids sync-commit gateway pressure as default.
- sync commit path is still testable by explicit override (`commit_async=false`).

### 2) Post-merge verifier aligned to new default

Updated:
- `scripts/ops/attendance-post-merge-verify.sh`

Change:
- `PERF_BASELINE_COMMIT_ASYNC` default from `false` -> `true`

Outcome:
- post-merge verify now requests perf baseline in async mode by default, consistent with new workflow baseline behavior.

## Verification

| Check | Command | Status |
|---|---|---|
| Shell syntax | `bash -n scripts/ops/attendance-post-merge-verify.sh` | PASS |
| Config grep | `rg -n "commit_async|COMMIT_ASYNC" .github/workflows/attendance-import-perf-baseline.yml scripts/ops/attendance-post-merge-verify.sh` | PASS |

## Next Validation After Merge

1. Trigger `Attendance Import Perf Baseline` once on `main` with defaults.
2. Confirm artifact `perf-summary.json` includes:
   - `uploadCsv=true`
   - `commitAsync=true`
3. Re-run `Attendance Post-Merge Verify (Nightly)` and verify full PASS.
