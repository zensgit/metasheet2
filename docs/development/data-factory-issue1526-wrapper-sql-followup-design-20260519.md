# Data Factory issue #1526 wrapper and SQL follow-up design - 2026-05-19

## Context

The bridge retest for
`metasheet-multitable-onprem-v2.5.0-k3wise-1f6204b3.zip` moved the Windows
on-prem package forward:

- the generated dependency-refresh wrapper entered and reached
  `pnpm install`;
- with `CI=true` set manually on the host, the wrapper recorded
  `pnpm install exit=0`;
- the parent PowerShell apply script still stopped before migrations because
  the child process exit code was logged as blank;
- after manual migrations/restart/healthcheck, the K3 WISE SQL Server source
  moved past `SQLSERVER_DRIVER_MISSING` and reached the real connection layer;
- the next SQL failure showed a comma-port server value being treated as a
  host and then combined with another `:1433` port.

This follow-up intentionally keeps the scope small. It does not add K3 WebAPI
read/list runtime, relationship resolution, SQL writes, or real K3 Save /
Submit / Audit behavior.

## Goals

1. Make dependency refresh non-interactive by default for Windows scheduled
   task deployments.
2. Make a successful wrapper result (`pnpm install exit=0`) allow the apply
   script to continue to migrations, PM2 restart, and healthcheck even when
   `Start-Process` exposes a blank exit code.
3. Normalize SQL Server `host,port` input so a K3 WISE operator can paste the
   common SQL Server comma-port form without producing `host,1433:1433`.
4. Keep future release packages gated on these markers through
   `multitable-onprem-package-verify.sh`.

## Windows dependency refresh changes

`scripts/ops/multitable-onprem-apply-package.ps1` now writes these additional
lines into the generated `dependency-refresh-*.cmd` wrapper:

- `CI=true`;
- `npm_config_yes=true`;
- `npm_config_confirm_modules_purge=false`;
- `PNPM_CONFIG_CONFIRM_MODULES_PURGE=false`;
- a visible non-interactive environment diagnostic line.

The intent is to make `pnpm install --frozen-lockfile` safe under scheduled
task / SYSTEM execution, where interactive prompts cannot be answered.

## Exit-code capture changes

The parent PowerShell process now does a second exit-state synchronization
before reading the child exit code:

1. wait for process exit confirmation with `WaitForExit()`;
2. refresh the process object with `Refresh()`;
3. read `ExitCode`;
4. if `ExitCode` is still blank, parse the wrapper stdout marker:
   `[dependency-refresh-wrapper] pnpm install exit=<n>`;
5. fail explicitly if neither the process nor wrapper marker provides a
   readable exit code.

This handles the bridge observation where the wrapper itself recorded exit `0`
but the parent apply script logged an empty child exit code.

## SQL Server host/port normalization

`plugins/plugin-integration-core/lib/adapters/k3-wise-sqlserver-executor.cjs`
already normalized `host:port` when no explicit `config.port` was provided.
This change extends the same behavior to SQL Server's common comma-port form:

```text
10.0.0.8,1433  ->  server=10.0.0.8, port=1433
sql.local:1433 ->  server=sql.local, port=1433
```

If both an embedded port and `system.config.port` are provided, the values must
match. A mismatch raises `SQLSERVER_PORT_INVALID` rather than guessing.

## Package verification

`scripts/ops/multitable-onprem-package-verify.sh` now requires packaged apply
helpers to contain:

- non-interactive dependency-refresh markers;
- the wrapper-exit-code recovery helper;
- `WaitForExit()` before `ExitCode` use.

The two design/verification documents for this follow-up are also added to the
on-prem package manifest so operators can trace why the change exists.

## Out of scope

- Real K3 Save / Submit / Audit.
- K3 WebAPI read/list runtime.
- Relationship resolver runtime.
- SQL middle-table writes.
- Reworking the known self-overwrite behavior where the first apply run can
  execute an already-loaded helper before the new package replaces it.

## Expected bridge retest

After merge and package publication:

1. deploy the fresh Windows zip twice if the host still has the known
   self-overwrite behavior;
2. confirm the dependency wrapper logs non-interactive env markers;
3. confirm dependency refresh completes without manually setting `CI=true`;
4. confirm the apply script continues to migrations, PM2 restart, and
   healthcheck after `pnpm install exit=0`;
5. rerun the K3 WISE SQL Server source test with a comma-port host and verify
   that the error, if any, is now a real network/auth/schema issue rather than
   a doubled host/port parse.
