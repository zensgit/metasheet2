# On-Prem Package Dependency Refresh Wrapper - Design - 2026-05-19

## Context

The #1526 bridge retest of package `k3wise-f477bdecb` proved that the previous
bounded dependency-refresh diagnostics were useful but incomplete.

The apply helper now logged:

- `pnpm path`;
- `pnpm version`;
- dependency-refresh stdout/stderr paths;
- timeout and heartbeat configuration.

The deploy still failed before migrations, PM2 restart, and healthcheck. The
first failure resolved `pnpm` to `pnpm.ps1`; a follow-up bridge experiment forced
a temporary `pnpm.cmd` shim and got heartbeat progress, but dependency refresh
still produced empty stdout/stderr and never completed under the scheduled task
context.

This means `.ps1` versus `.cmd` is a real problem, but not the whole problem.
The deploy path also needs a command wrapper that proves the child command
entered, prints scheduler-safe diagnostics, pins the pnpm store, and can clean up
the process tree on timeout.

## Change

The PowerShell apply helper keeps `InstallDeps=1` as the default, but changes
the Windows dependency-refresh execution model:

1. Prefer `pnpm.cmd` for install execution. If only `pnpm.ps1` is available, the
   helper falls back to `powershell.exe -File <pnpm.ps1>`.
2. Generate `output\logs\dependency-refresh-<timestamp>.cmd`.
3. Launch that wrapper through `cmd.exe /d /s /c`.
4. Make the wrapper print its own entry marker, working directory, Windows user,
   `where node`, `where pnpm`, pnpm version, registry, store-dir, and install
   start/end lines.
5. Run:

   ```bat
   pnpm install --frozen-lockfile --reporter=append-only --store-dir <deploy-root>\.pnpm-store
   ```

6. Keep the existing stdout/stderr split logs:

   - `output\logs\dependency-refresh-*.stdout.log`
   - `output\logs\dependency-refresh-*.stderr.log`

7. Extend heartbeat lines with current stdout/stderr byte counts.
8. On timeout, try `taskkill.exe /PID <pid> /T /F` before falling back to
   `Process.Kill()`.

## Why This Shape

The package still intentionally does not bundle `node_modules`. Reintroducing a
bundled dependency tree would be a larger packaging decision and could carry OS,
native-module, and disk-size risk.

The wrapper approach keeps the current package model but gives the bridge a
clear split:

- wrapper never entered: scheduled-task/process launch problem;
- wrapper entered but pnpm version/config fails: PATH/Corepack/pnpm problem;
- install starts but hangs: pnpm registry/store/network/lockfile problem;
- install succeeds but deploy fails later: migration/restart/healthcheck problem.

The deploy-root `.pnpm-store` avoids dependence on a user-profile store that may
not be readable or writable from Windows scheduled task / SYSTEM context.

## Guardrails

- No product runtime behavior changes.
- No K3 WebAPI, SQL executor, relationship resolver, or Save/Submit/Audit
  changes.
- No database migration changes.
- No secrets are written intentionally; diagnostics include paths, versions,
  registry URL, and store location only.
- `InstallDeps=0` remains available for advanced operators who have refreshed
  dependencies out of band.

## Package Verification

`scripts/ops/multitable-onprem-package-verify.sh` now fails if the packaged
PowerShell helper omits any of these markers:

- `Resolve-PnpmInstallCommand`;
- `pnpm.cmd`;
- `cmd.exe`;
- `dependency-refresh-wrapper`;
- `--reporter=append-only`;
- `--store-dir`;
- `.pnpm-store`;
- `config get registry`;
- `config get store-dir`;
- `taskkill.exe`.

This makes the fix part of the release artifact contract, not just the source
tree.

## Retest Boundary

The next bridge retest should first prove that deploy reaches migrations,
restart, and healthcheck. Only then should the SQL Server source test be treated
as meaningful.

Real K3 Save, Submit, and Audit remain out of scope for this package retest.
