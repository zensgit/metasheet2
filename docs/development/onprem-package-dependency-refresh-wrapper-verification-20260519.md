# On-Prem Package Dependency Refresh Wrapper - Verification - 2026-05-19

## Issue Evidence

Latest #1526 bridge feedback after package `k3wise-f477bdecb`:

- first run used the previous root apply helper, then copied the new helper to
  disk;
- second run used the new diagnostics and printed `pnpm path`, `pnpm version`,
  timeout, heartbeat, and dependency-refresh log paths;
- dependency refresh exited with result `1` before migrations, restart, or
  healthcheck;
- stdout/stderr files existed but stayed at `0` bytes;
- forcing a temporary `pnpm.cmd` shim changed the resolved path and allowed
  heartbeat lines, but dependency refresh still produced empty logs and did not
  complete.

Conclusion: the deploy path needs a Windows command wrapper and stronger
scheduler-context diagnostics before the SQL source retest can be trusted.

## Files Changed

- `scripts/ops/multitable-onprem-apply-package.ps1`
- `scripts/ops/multitable-onprem-package-build.sh`
- `scripts/ops/multitable-onprem-package-verify.sh`
- `docs/deployment/multitable-windows-onprem-easy-start-20260319.md`
- `docs/deployment/multitable-onprem-package-layout-20260319.md`
- `docs/operations/integration-k3wise-internal-trial-runbook.md`
- `docs/operations/integration-k3wise-sql-executor-bridge-handoff.md`
- `docs/development/onprem-package-dependency-refresh-wrapper-design-20260519.md`
- `docs/development/onprem-package-dependency-refresh-wrapper-verification-20260519.md`

## Assertions

| Area | Assertion |
| --- | --- |
| pnpm command | Install prefers `pnpm.cmd`; `.ps1` is fallback only. |
| Wrapper | Dependency refresh runs through generated `dependency-refresh-*.cmd` via `cmd.exe /d /s /c`. |
| Output proof | Wrapper emits an entry marker before invoking pnpm. |
| Diagnostics | Wrapper prints `where node`, `where pnpm`, pnpm version, registry, and store-dir. |
| Store | Install uses deploy-root `.pnpm-store` via `--store-dir`. |
| Logs | stdout/stderr still go to `dependency-refresh-*.stdout.log` and `.stderr.log`. |
| Heartbeat | Heartbeat now includes current stdout/stderr byte counts. |
| Timeout cleanup | Timeout attempts `taskkill.exe /PID <pid> /T /F` before `Process.Kill()`. |
| Package contract | Build + verify require the new design/verification docs and helper markers. |
| Scope | No integration-core runtime, SQL executor, DB migration, or K3 write behavior changes. |

## Local Verification Commands

Executed from branch `codex/onprem-deps-refresh-wrapper-20260519`:

| Command | Result |
| --- | --- |
| `bash -n scripts/ops/multitable-onprem-package-build.sh` | PASS |
| `bash -n scripts/ops/multitable-onprem-package-verify.sh` | PASS |
| marker scan for `pnpm.cmd`, `cmd.exe`, wrapper, append-only reporter, store-dir, `.pnpm-store`, registry/store diagnostics, `taskkill.exe` | PASS |
| `git diff --check origin/main...HEAD` | PASS |
| `OUTPUT_DIR=/tmp/ms2-onprem-deps-wrapper-package PACKAGE_TAG=deps-wrapper-smoke INSTALL_DEPS=1 BUILD_WEB=1 BUILD_BACKEND=1 scripts/ops/multitable-onprem-package-build.sh` | PASS |
| `scripts/ops/multitable-onprem-package-verify.sh /tmp/ms2-onprem-deps-wrapper-package/metasheet-multitable-onprem-v2.5.0-deps-wrapper-smoke.zip` | PASS, `Package verify OK` |
| `scripts/ops/multitable-onprem-package-verify.sh /tmp/ms2-onprem-deps-wrapper-package/metasheet-multitable-onprem-v2.5.0-deps-wrapper-smoke.tgz` | PASS, `Package verify OK` |
| zip spot-check for packaged helper markers and new docs | PASS |
| `node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs` | PASS, 27/27 |
| `node --test scripts/ops/integration-k3wise-postdeploy-summary.test.mjs` | PASS, 16/16 |
| `pnpm verify:integration-k3wise:poc` | PASS, preflight/evidence/fixtures/mock chain |

PowerShell parser validation was not run locally because `pwsh` is not
installed in this macOS Codex environment.

## Package Verification Plan

Package proof:

```bash
OUTPUT_DIR=/tmp/ms2-onprem-deps-wrapper-package \
PACKAGE_TAG=deps-wrapper-smoke \
  scripts/ops/multitable-onprem-package-build.sh

scripts/ops/multitable-onprem-package-verify.sh \
  /tmp/ms2-onprem-deps-wrapper-package/metasheet-multitable-onprem-v2.5.0-deps-wrapper-smoke.zip

scripts/ops/multitable-onprem-package-verify.sh \
  /tmp/ms2-onprem-deps-wrapper-package/metasheet-multitable-onprem-v2.5.0-deps-wrapper-smoke.tgz
```

Expected: both verifier runs return `Package verify OK`.

## Bridge Retest Plan

Deploy the next published Windows zip, then check:

1. apply log includes:
   - `pnpm path:`;
   - `pnpm install path:`;
   - `dependency refresh wrapper:`;
   - `dependency refresh local store:`;
   - `pnpm config registry:`;
   - `pnpm config store-dir:`;
   - `Refresh dependencies (cmd.exe /c pnpm install --frozen-lockfile)`;
2. stdout log includes `[dependency-refresh-wrapper] wrapper entered`;
3. stdout log includes `pnpm install starting`;
4. deploy reaches migrations, PM2 restart, and healthcheck;
5. only then rerun the SQL Server source test.

Expected SQL retest after a completed deploy:

- no `SQLSERVER_DRIVER_MISSING`;
- either successful SQL source connection or a concrete SQL config, network,
  auth, allowlist, or schema error.

No real K3 Save, Submit, or Audit is part of this verification.
