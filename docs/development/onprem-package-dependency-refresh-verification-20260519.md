# On-Prem Package Dependency Refresh - Verification - 2026-05-19

## Issue Evidence

Bridge feedback on #1526 after deploying
`metasheet-multitable-onprem-v2.5.0-k3wise-316d3ca13.zip`:

- deployment, migrations, restart, and health checks passed;
- staging-to-K3 dry-run stayed healthy;
- SQL Server source no longer returned `SQLSERVER_EXECUTOR_MISSING`;
- SQL Server source returned `SQLSERVER_DRIVER_MISSING`.

Interpretation: executor injection works, but the deployed runtime did not
install the new `mssql` dependency introduced by the package.

## Files Verified

- `scripts/ops/multitable-onprem-apply-package.ps1`
- `scripts/ops/multitable-onprem-package-build.sh`
- `scripts/ops/multitable-onprem-package-verify.sh`
- `scripts/ops/integration-k3wise-postdeploy-smoke.mjs`
- `scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs`
- `docs/deployment/multitable-windows-onprem-easy-start-20260319.md`
- `docs/deployment/multitable-onprem-package-layout-20260319.md`
- `docs/operations/integration-k3wise-internal-trial-runbook.md`
- `docs/operations/integration-k3wise-sql-executor-bridge-handoff.md`

## Assertions

| Area | Assertion |
| --- | --- |
| Windows apply helper | With default `InstallDeps=1`, the helper runs `pnpm install --frozen-lockfile` even when root `node_modules` already exists. |
| Escape hatch | `InstallDeps=0` still skips dependency refresh for advanced/manual operators. |
| Package metadata | Generated `PACKAGE-METADATA.json` declares `dependencyInstallMode: refresh-on-apply`. |
| Package verifier | Verifier fails if the PowerShell helper gates install only on root `node_modules` existence. |
| SQL diagnostic | Postdeploy smoke distinguishes `SQLSERVER_DRIVER_MISSING` from `SQLSERVER_EXECUTOR_MISSING` and gives the dependency refresh action. |
| Docs | Windows/on-prem docs no longer tell operators dependency install only happens when `node_modules` is missing. |

## Local Verification Commands

Executed from branch `codex/onprem-package-refresh-deps-20260519`:

| Command | Result |
| --- | --- |
| `bash -n scripts/ops/multitable-onprem-package-build.sh` | PASS |
| `bash -n scripts/ops/multitable-onprem-package-verify.sh` | PASS |
| `node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs` | PASS, 27/27 |
| `node --test scripts/ops/integration-k3wise-postdeploy-summary.test.mjs` | PASS, 16/16 |
| `pnpm verify:integration-k3wise:poc` | PASS |
| `git diff --check` | PASS |

Local package proof:

```bash
OUTPUT_DIR=/tmp/ms2-onprem-deps-refresh-package \
PACKAGE_TAG=deps-refresh-smoke \
  scripts/ops/multitable-onprem-package-build.sh

scripts/ops/multitable-onprem-package-verify.sh \
  /tmp/ms2-onprem-deps-refresh-package/metasheet-multitable-onprem-v2.5.0-deps-refresh-smoke.zip

scripts/ops/multitable-onprem-package-verify.sh \
  /tmp/ms2-onprem-deps-refresh-package/metasheet-multitable-onprem-v2.5.0-deps-refresh-smoke.tgz
```

Both package verifier runs returned `Package verify OK`. The package metadata
now includes `"dependencyInstallMode": "refresh-on-apply"`, and the verifier
checks the PowerShell apply helper for the refresh-on-apply marker.

Optional PowerShell syntax check on a Windows host:

```powershell
powershell -NoProfile -Command "$null = [scriptblock]::Create((Get-Content -Raw scripts\ops\multitable-onprem-apply-package.ps1)); 'syntax-ok'"
```

## Bridge Retest Plan

After merge and package publish:

1. Deploy the new Windows zip with `deploy.bat <package.zip>`.
2. Confirm deploy logs include `Refresh dependencies (pnpm install --frozen-lockfile)`.
3. Confirm `plugins/plugin-integration-core/node_modules/mssql` resolves, or
   use the UI SQL source test as the runtime proof.
4. Rerun the SQL Server source test in Data Factory / K3 preset.
5. Expected: no `SQLSERVER_DRIVER_MISSING`.

No real K3 Save / Submit / Audit is part of this verification.
