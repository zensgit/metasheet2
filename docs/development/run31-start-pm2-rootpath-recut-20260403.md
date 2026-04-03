# Run 31 Start PM2 Root Path Recut

Date: 2026-04-03

## Context

Closed PR `#596` contained a valid Windows/PM2 packaging fix, but the branch had
drifted too far behind `main` and conflicted with newer release work.

The practical issue is that generated Windows entrypoints passed `%~dp0` directly
into PowerShell. On Windows that value can carry trailing-slash quoting that makes
`Resolve-Path` brittle under Task Scheduler or wrapper invocation.

## Recut Scope

- `scripts/ops/attendance-onprem-start-pm2.ps1`
- `scripts/ops/attendance-onprem-deploy-run.ps1`
- `scripts/ops/attendance-onprem-package-build.sh`
- `scripts/ops/attendance-onprem-package-verify.sh`

## Decision

Keep the recut narrowly focused on path normalization and package verification:

1. Generate `.bat` wrappers with `-RootDir "%~dp0."`
2. Normalize quoted/trailing `RootDir` input inside both PowerShell entrypoints
3. Fail package verification if a future package regresses to bare `%~dp0`

## Verification

Run:

```bash
bash -n scripts/ops/attendance-onprem-package-build.sh
bash -n scripts/ops/attendance-onprem-package-verify.sh
rg -n --fixed-strings -- '-RootDir "%~dp0."' scripts/ops/attendance-onprem-package-build.sh scripts/ops/attendance-onprem-package-verify.sh
rg -n 'Resolve-RootDirPath|Trim\\(\\)\\.Trim' scripts/ops/attendance-onprem-start-pm2.ps1 scripts/ops/attendance-onprem-deploy-run.ps1
```

Expected:

- both bash scripts parse cleanly
- generated wrapper templates now use `"%~dp0."`
- both PowerShell entrypoints normalize incoming `RootDir` before path resolution
