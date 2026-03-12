# Attendance Parallel Development Report (Round23, 2026-03-12)

## Scope

B-line high-scale benchmark hardening:

1. add a dedicated GA workflow for 100k+ import benchmark lane.
2. add one-command ops script to dispatch + download + validate high-scale artifacts.
3. add local tests so the new runner remains stable before merge.

## Implementation

### 1) New GA workflow: high-scale benchmark lane

Added:

- `.github/workflows/attendance-import-perf-highscale.yml`

Key behavior:

- `workflow_dispatch` + weekly schedule (`0 6 * * 0`)
- drill support (`drill`, `drill_fail`, optional `issue_title`)
- default high-scale profile:
  - `rows=100000`
  - `mode=commit`
  - `commit_async=true`
  - `upload_csv=true`
  - `payload_source=auto`
- transient retry for perf runner (same pattern as baseline/longrun)
- P2 issue tracking lifecycle:
  - default title: `[Attendance P2] Perf highscale alert`
  - fail => create/reopen/comment
  - pass => close
  - drill runs do not create issue unless `issue_title` is explicitly provided

### 2) New ops runner: dispatch + contract verify

Added:

- `scripts/ops/attendance-run-perf-highscale.sh`

Capabilities:

- dispatches `attendance-import-perf-highscale.yml` via shared dispatcher
- downloads artifacts under:
  - `output/playwright/attendance-perf-highscale/<timestamp>/ga/<runId>/...`
- validates `perf-summary.json` contract:
  - `rows >= expected`
  - `mode` / `uploadCsv` / `commitAsync` match requested values
  - optional `payloadSource` assertion
- writes local evidence:
  - `summary.md`
  - `summary.json`
- supports dispatcher injection for local deterministic tests:
  - `DISPATCHER=<path>`

### 3) New local tests + package scripts

Added:

- `scripts/ops/attendance-run-perf-highscale.test.mjs`

Updated:

- `package.json`
  - `verify:attendance-perf-highscale`
  - `verify:attendance-perf-highscale:test`

## Local Verification

| Check | Command | Status | Evidence |
|---|---|---|---|
| High-scale runner shell syntax | `bash -n scripts/ops/attendance-run-perf-highscale.sh` | PASS | stdout |
| High-scale runner tests | `node --test scripts/ops/attendance-run-perf-highscale.test.mjs` | PASS | stdout (2/2) |
| High-scale runner tests (pnpm shortcut) | `pnpm verify:attendance-perf-highscale:test` | PASS | stdout (2/2) |
| Existing gate parser + fast regression tests | `node --test scripts/ops/attendance-daily-gate-report.test.mjs scripts/ops/attendance-fast-parallel-regression.test.mjs` | PASS | stdout (18/18) |
| Workflow YAML parse sanity | `python3 -c ... yaml.safe_load(...)` | PASS | parsed top-level keys |

## Post-Merge GA Verification Plan (must run on `main`)

1. Drill fail (expected failure path)

```bash
gh workflow run attendance-import-perf-highscale.yml \
  -f drill=true \
  -f drill_fail=true \
  -f issue_title='[Attendance Highscale Drill] Perf highscale issue test'
```

2. Drill recovery pass (expected close path)

```bash
gh workflow run attendance-import-perf-highscale.yml \
  -f drill=true \
  -f drill_fail=false \
  -f issue_title='[Attendance Highscale Drill] Perf highscale issue test'
```

3. Real high-scale run (100k)

```bash
pnpm verify:attendance-perf-highscale
```

4. Evidence download template

```bash
RUN_ID="<RUN_ID>"
gh run download "${RUN_ID}" -D "output/playwright/ga/${RUN_ID}"
```

Expected evidence root:

- `output/playwright/attendance-perf-highscale/<timestamp>/summary.md`
- `output/playwright/attendance-perf-highscale/<timestamp>/summary.json`
- `output/playwright/attendance-perf-highscale/<timestamp>/ga/<runId>/...`

## Impact

- no business API path changes.
- adds a dedicated, auditable high-scale benchmark lane and reusable verification entrypoint.
- keeps alerting non-paging (`[Attendance P2] ...`) while preserving recovery auto-close behavior.
