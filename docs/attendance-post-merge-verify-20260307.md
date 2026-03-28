# Attendance Post-Merge Verify Playbook (2026-03-07)

Purpose:

- Run a reproducible, one-command post-merge verification on `main`.
- Trigger three production workflows in order:
  1. `attendance-branch-policy-drift-prod.yml`
  2. `attendance-strict-gates-prod.yml`
  3. `attendance-daily-gate-dashboard.yml`
- Optionally download artifacts for every run into a single local evidence directory.

## Command

```bash
pnpm verify:attendance-post-merge
```

Default behavior:

- Branch: `main`
- Download artifacts: `true`
- Strict checks enabled (`require_import_upload=true`, `require_idempotency=true`, etc.)
- Dashboard `lookback_hours=48`

Artifacts output:

- `output/playwright/attendance-post-merge-verify/<timestamp>/summary.md`
- `output/playwright/attendance-post-merge-verify/<timestamp>/summary.json`
- `output/playwright/attendance-post-merge-verify/<timestamp>/results.tsv`
- Downloaded GitHub artifacts under:
  - `output/playwright/attendance-post-merge-verify/<timestamp>/ga/<runId>/`

## Useful overrides

Quick run without strict (for script debugging only):

```bash
SKIP_STRICT=true pnpm verify:attendance-post-merge
```

Do not download artifacts:

```bash
DOWNLOAD_ARTIFACTS=false pnpm verify:attendance-post-merge
```

Run with stricter dashboard lookback:

```bash
LOOKBACK_HOURS=24 pnpm verify:attendance-post-merge
```

## Exit semantics

- Exit `0`: all non-skipped gates succeeded.
- Exit `1`: one or more gates failed.

## Notes

- This script triggers `workflow_dispatch` runs and requires `gh` CLI auth with repository workflow permissions.
- Never write real secrets/tokens into docs; runtime env only.
