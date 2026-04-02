# Run 27 Start PM2 Remote Path Hotfix

## Context

Issue [#595](https://github.com/zensgit/metasheet2/issues/595) reported that `start-pm2-remote.bat` failed under Windows Task Scheduler because the generated batch wrappers passed `%~dp0` directly into PowerShell. On Windows, `%~dp0` ends with a trailing backslash, and when quoted it can surface as an invalid path payload for `Resolve-Path`.

## Decision

Use a two-layer fix:

1. Generate Windows batch entrypoints with `-RootDir "%~dp0."` instead of `"%~dp0"`.
2. Normalize and validate `RootDir` inside both PowerShell entry scripts before calling `Resolve-Path`-equivalent filesystem operations.

## Scope

- `scripts/ops/attendance-onprem-package-build.sh`
- `scripts/ops/attendance-onprem-start-pm2.ps1`
- `scripts/ops/attendance-onprem-deploy-run.ps1`
- `scripts/ops/attendance-onprem-package-verify.sh`

## Why This Shape

- Fixing only the batch wrapper would leave the PowerShell entrypoints brittle for any future caller that passes quoted paths.
- Fixing only PowerShell would still allow bad wrappers to ship again.
- Adding a verify gate prevents a future packaging regression from reaching another on-prem run.

## Expected Outcome

- `start-pm2-remote.bat` and `deploy-runXX.bat` pass a Windows-safe root path.
- The PowerShell entrypoints tolerate quoted scheduler input and normalize it into a stable absolute path.
- Package verification fails fast if a future run reintroduces `%~dp0` without the `.` suffix.
