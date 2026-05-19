# On-Prem Package Dependency Refresh - Design - 2026-05-19

## Context

The bridge retest after package `k3wise-316d3ca13` showed progress on #1526:
the K3 WISE SQL Server source no longer reported `SQLSERVER_EXECUTOR_MISSING`.
It instead reported `SQLSERVER_DRIVER_MISSING`, meaning the packaged executor
was wired but the deployed runtime could not load `mssql`.

The root cause is the Windows package apply path. The package intentionally does
not bundle `node_modules`, and `deploy.bat` delegates to
`scripts/ops/multitable-onprem-apply-package.ps1`. That helper only ran
`pnpm install --frozen-lockfile` when root `node_modules` was missing. Upgrade
deployments already have `node_modules`, so a corrective package that adds a
new workspace dependency can copy the new `package.json` / lockfile without
installing the new dependency.

## Change

The PowerShell apply helper now refreshes dependencies whenever `InstallDeps` is
enabled:

```powershell
if ($InstallDeps -ne '0') {
  pnpm install --frozen-lockfile
}
```

This intentionally trades a little upgrade time for deterministic runtime
dependencies. Operators can still pass `-InstallDeps 0` only when they have
already refreshed dependencies out of band.

The package metadata and docs now state the policy as `refresh-on-apply`, not
"install only when node_modules is missing".

## Guardrails

- No runtime product behavior changes.
- No database migration changes.
- No K3 Save / Submit / Audit changes.
- Bash/WSL package apply already goes through the package upgrade helper, which
  runs dependency install when `INSTALL_DEPS=1`; this slice fixes the native
  Windows PowerShell apply path that bridge testing uses.
- Package verification now fails if the PowerShell helper reintroduces the
  root-`node_modules` existence gate.

## Expected Bridge Result

After publishing and deploying a package with this fix, the bridge SQL source
test should no longer fail with `SQLSERVER_DRIVER_MISSING` caused by missing
`mssql`. The next expected outcomes are:

- valid SQL Server config and credentials: connection succeeds;
- invalid config or network: concrete SQL Server connection/config error;
- built-in write attempt: still blocked with `SQLSERVER_WRITE_EXECUTOR_DISABLED`.
