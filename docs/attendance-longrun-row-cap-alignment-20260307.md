# Attendance Longrun Row-Cap Alignment (2026-03-07)

## Background

- Production guardrail is intentionally set to `ATTENDANCE_IMPORT_CSV_MAX_ROWS=20000`.
- Longrun workflow still attempted `rows50k/100k/500k` scenarios by default.
- Result: repeated false-failures (`CSV_TOO_LARGE`) in longrun P1 gate, even when core service was healthy.

## Root Cause Evidence

- Main run: `Attendance Import Perf Long Run` `#22791032114` (FAIL)
- Failure signature in artifacts:
  - `HTTP 400`
  - `error.code=CSV_TOO_LARGE`
  - `message=CSV exceeds max rows (20000)`
- Evidence:
  - `output/playwright/ga/22791032114/attendance-import-perf-longrun-rows100k-preview-22791032114-1/current/rows100k-preview/perf.log`
  - `output/playwright/ga/22791032114/attendance-import-perf-longrun-trend-22791032114-1/20260307-032631/attendance-import-perf-longrun-trend.md`

## Code Change

File:

- `.github/workflows/attendance-import-perf-longrun.yml`

Change set:

1. Added workflow input `max_csv_rows` (default `20000`).
2. Added `MAX_CSV_ROWS` env in `perf-scenarios`.
3. Added step `Evaluate scenario gate`:
   - validates numeric cap
   - skips scenarios when `rows > MAX_CSV_ROWS`
   - emits explicit skip reason.
4. Wired execution to gate output:
   - `Run long-run scenario` only when gate allows.
   - `Capture scenario summary` only when gate allows.
   - unified `Mark scenario as skipped` message.

Commit:

- `c71b8e49cc323302ebe1906af743f281b80157e5`
- Branch: `codex/attendance-longrun-row-cap-gate`

## Validation

### Workflow syntax

- Local YAML parse: PASS
  - `ruby -e "require 'yaml'; YAML.load_file('.github/workflows/attendance-import-perf-longrun.yml')"`

### GA run (post-fix branch verification)

- Run: `#22791311493` (SUCCESS)
- URL: `https://github.com/zensgit/metasheet2/actions/runs/22791311493`
- Observed behavior:
  - `rows10k-commit`: executed and passed
  - `rows50k-preview`: skipped by row-cap gate
  - `rows100k-preview`: skipped by row-cap gate
  - `rows100k-commit`: skipped by row-cap gate (+ include flag)
  - `rows500k-preview`: skipped by row-cap gate
  - `rows500k-commit`: skipped by row-cap gate (+ include flag)
  - `trend-report`: PASS
  - `Perf Longrun Issue Alert (P1)`: PASS

Artifacts downloaded to:

- `output/playwright/ga/22791311493/attendance-import-perf-longrun-rows10k-commit-22791311493-1/current-flat/rows10000-commit.json`
- `output/playwright/ga/22791311493/attendance-import-perf-longrun-trend-22791311493-1/20260307-034409/attendance-import-perf-longrun-trend.md`
- `output/playwright/ga/22791311493/attendance-import-perf-longrun-trend-22791311493-1/20260307-034409/attendance-import-perf-longrun-trend.json`

## Operational Notes

- This fix aligns longrun with the production safety cap and removes false P1 noise.
- For dedicated high-capacity perf environments, you can override:
  - `gh workflow run attendance-import-perf-longrun.yml -f max_csv_rows=120000 -f upload_csv=true`

## Next Actions

1. Open/merge PR from `codex/attendance-longrun-row-cap-gate`.
2. Re-run on `main`:
   - `Attendance Import Perf Long Run`
   - `Attendance Daily Gate Dashboard`
3. Verify `gateFlat.longrun` references the new PASS run on `main`.
4. If needed, close/reconcile any stale longrun P1 issue created by pre-fix runs.
