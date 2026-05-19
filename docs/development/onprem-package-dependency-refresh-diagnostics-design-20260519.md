# On-Prem Package Dependency Refresh Diagnostics - Design - 2026-05-19

## Context

Bridge retest after package `k3wise-905d1ea40` confirmed that the package now
reaches the dependency refresh step during Windows apply:

```text
Refresh dependencies (pnpm install --frozen-lockfile)
Scope: all 5 workspace projects
```

The scheduled deployment task then stayed `Running` and the apply log did not
advance to migrations, PM2 restart, or final healthcheck. Because the deploy
never completed, the SQL Server source test could not be used to judge whether
`SQLSERVER_DRIVER_MISSING` was fixed.

The gap is operational, not K3 runtime logic: dependency refresh was a direct
PowerShell command with no child-process log paths, heartbeat, elapsed-time
visibility, or timeout.

## Change

The Windows apply helper now runs dependency refresh through a bounded logged
child-process wrapper.

Default behavior:

- command: `pnpm install --frozen-lockfile`;
- timeout: `DependencyRefreshTimeoutSec=1800`;
- heartbeat: `DependencyRefreshHeartbeatSec=60`;
- stdout log: `output\logs\dependency-refresh-*.stdout.log`;
- stderr log: `output\logs\dependency-refresh-*.stderr.log`.

The helper also logs:

- resolved `pnpm` command path;
- `pnpm --version` when available;
- working directory;
- timeout and heartbeat configuration;
- periodic "still running after ..." messages;
- exit code and elapsed time;
- stdout/stderr tail on non-zero exit or timeout.

## Operator Controls

The existing `InstallDeps=0` escape hatch is unchanged for advanced operators
who deliberately refresh dependencies out of band.

New controls:

```powershell
-DependencyRefreshTimeoutSec 3600
-DependencyRefreshHeartbeatSec 30
```

These are intentionally deploy-helper options only. They do not alter product
runtime, SQL executor behavior, K3 WebAPI behavior, or database migrations.

## Package Guardrail

`scripts/ops/multitable-onprem-package-verify.sh` now checks that packaged
Windows apply helpers include:

- dependency timeout option;
- dependency heartbeat option;
- dependency refresh stdout/stderr log marker;
- `pnpm path` and `pnpm version` logging;
- heartbeat text;
- timeout failure text.

This makes the packaging path fail if a future change reverts the helper to a
silent unbounded install.

## Expected Bridge Result

After publishing a package with this change:

1. dependency refresh either completes and deployment proceeds to migrations,
   restart, and healthcheck;
2. or dependency refresh times out with enough logs to diagnose path, version,
   registry, lockfile, permissions, or network issues.

Only after deployment reaches the final healthcheck should the bridge rerun the
K3 WISE SQL Server source test. A still-running or timed-out dependency refresh
is a deployment failure, not a valid SQL runtime result.

## Non-Goals

- No SQL executor logic changes.
- No K3 WebAPI read/list runtime changes.
- No relationship resolver changes.
- No K3 Save / Submit / Audit changes.
- No `node_modules` bundling.
