# On-Prem Package Dependency Refresh Diagnostics - Verification - 2026-05-19

## Issue Evidence

Latest #1526 bridge feedback after package `k3wise-905d1ea40`:

- Windows zip checksum and package metadata were verified on the test host.
- `PACKAGE-METADATA.json` showed `dependencyInstallMode=refresh-on-apply`.
- Deploy log reached:
  - `Refresh dependencies (pnpm install --frozen-lockfile)`;
  - `Scope: all 5 workspace projects`.
- The scheduled deployment task stayed `Running`.
- The apply log did not reach migrations, restart, or healthcheck.
- SQL Server source retest was blocked because deployment had not finalized.

## Files Changed

- `scripts/ops/multitable-onprem-apply-package.ps1`
- `scripts/ops/multitable-onprem-package-verify.sh`
- `docs/deployment/multitable-windows-onprem-easy-start-20260319.md`
- `docs/deployment/multitable-onprem-package-layout-20260319.md`
- `docs/operations/integration-k3wise-internal-trial-runbook.md`
- `docs/operations/integration-k3wise-sql-executor-bridge-handoff.md`
- `docs/development/onprem-package-dependency-refresh-diagnostics-design-20260519.md`
- `docs/development/onprem-package-dependency-refresh-diagnostics-verification-20260519.md`

## Assertions

| Area | Assertion |
| --- | --- |
| Timeout | Dependency refresh has `DependencyRefreshTimeoutSec`, default `1800`. |
| Heartbeat | Dependency refresh has `DependencyRefreshHeartbeatSec`, default `60`, and emits "still running after ..." progress. |
| Logs | Dependency refresh writes `dependency-refresh-*.stdout.log` and `dependency-refresh-*.stderr.log` under `output\logs`. |
| Command identity | Apply log includes resolved `pnpm` path and `pnpm --version` when available. |
| Failure mode | Timeout or non-zero exit includes log paths and stdout/stderr tail. |
| Package verification | Package verifier fails if these diagnostic markers are absent from the packaged PowerShell helper. |
| Scope | No SQL executor, K3 WebAPI, relationship resolver, DB migration, or real K3 write behavior changes. |

## Local Verification Commands

Executed from branch `codex/onprem-deps-refresh-timeout-20260519`:

| Command | Result |
| --- | --- |
| `bash -n scripts/ops/multitable-onprem-package-build.sh` | PASS |
| `bash -n scripts/ops/multitable-onprem-package-verify.sh` | PASS |
| marker scan for timeout / heartbeat / logs / pnpm path / pnpm version / timeout text | PASS |
| `git diff --check` | PASS |
| `OUTPUT_DIR=/tmp/ms2-onprem-deps-timeout-package PACKAGE_TAG=deps-timeout-smoke INSTALL_DEPS=1 BUILD_WEB=1 BUILD_BACKEND=1 scripts/ops/multitable-onprem-package-build.sh` | PASS |
| `scripts/ops/multitable-onprem-package-verify.sh /tmp/ms2-onprem-deps-timeout-package/metasheet-multitable-onprem-v2.5.0-deps-timeout-smoke.zip` | PASS |
| `scripts/ops/multitable-onprem-package-verify.sh /tmp/ms2-onprem-deps-timeout-package/metasheet-multitable-onprem-v2.5.0-deps-timeout-smoke.tgz` | PASS |
| zip spot-check for packaged PowerShell diagnostic markers | PASS |
| `node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs` | PASS, 27/27 |
| `node --test scripts/ops/integration-k3wise-postdeploy-summary.test.mjs` | PASS, 16/16 |
| `pnpm verify:integration-k3wise:poc` | PASS |

PowerShell parser validation was not run locally because `pwsh` is not
installed in this macOS Codex environment.

Reproduction commands:

```bash
bash -n scripts/ops/multitable-onprem-package-verify.sh

rg --fixed-strings 'DependencyRefreshTimeoutSec' scripts/ops/multitable-onprem-apply-package.ps1
rg --fixed-strings 'DependencyRefreshHeartbeatSec' scripts/ops/multitable-onprem-apply-package.ps1
rg --fixed-strings 'dependency-refresh-' scripts/ops/multitable-onprem-apply-package.ps1
rg --fixed-strings 'pnpm path:' scripts/ops/multitable-onprem-apply-package.ps1
rg --fixed-strings 'pnpm version:' scripts/ops/multitable-onprem-apply-package.ps1
rg --fixed-strings 'still running after' scripts/ops/multitable-onprem-apply-package.ps1
rg --fixed-strings 'timed out after' scripts/ops/multitable-onprem-apply-package.ps1

git diff --check origin/main...HEAD
```

Optional PowerShell syntax check when `pwsh` is available:

```bash
pwsh -NoProfile -Command \
  '$null = [scriptblock]::Create((Get-Content -Raw scripts/ops/multitable-onprem-apply-package.ps1)); "syntax-ok"'
```

Package proof:

```bash
OUTPUT_DIR=/tmp/ms2-onprem-deps-timeout-package \
PACKAGE_TAG=deps-timeout-smoke \
  scripts/ops/multitable-onprem-package-build.sh

scripts/ops/multitable-onprem-package-verify.sh \
  /tmp/ms2-onprem-deps-timeout-package/metasheet-multitable-onprem-v2.5.0-deps-timeout-smoke.zip

scripts/ops/multitable-onprem-package-verify.sh \
  /tmp/ms2-onprem-deps-timeout-package/metasheet-multitable-onprem-v2.5.0-deps-timeout-smoke.tgz
```

The verifier must return `Package verify OK` for both archives.

## Bridge Retest Plan

After merge and package publish:

1. Deploy the new Windows zip with `deploy.bat <package.zip>`.
2. Confirm apply logs include:
   - `pnpm path: ...`;
   - `pnpm version: ...`;
   - `Refresh dependencies (pnpm install --frozen-lockfile)`;
   - heartbeat lines if the install runs longer than one heartbeat interval.
3. If the install is slow, inspect:
   - `output\logs\dependency-refresh-*.stdout.log`;
   - `output\logs\dependency-refresh-*.stderr.log`.
4. Confirm deployment reaches migrations, restart, and healthcheck.
5. Rerun K3 WISE SQL Server source test.

Expected SQL retest result after a completed deployment:

- no `SQLSERVER_DRIVER_MISSING`;
- either successful SQL source connection or a concrete SQL Server
  config/network/auth/schema error.

No real K3 Save / Submit / Audit is part of this verification.
