# Data Factory issue #1526 wrapper and SQL follow-up verification - 2026-05-19

## Scope

This verification covers the #1526 bridge follow-up for:

- Windows dependency refresh non-interactive defaults;
- PowerShell child process exit-code recovery;
- SQL Server comma-port normalization;
- package verification markers and manifest inclusion.

It does not validate real K3 writes or customer GATE runtime work.

## Changed files

- `scripts/ops/multitable-onprem-apply-package.ps1`
- `scripts/ops/multitable-onprem-package-build.sh`
- `scripts/ops/multitable-onprem-package-verify.sh`
- `plugins/plugin-integration-core/lib/adapters/k3-wise-sqlserver-executor.cjs`
- `plugins/plugin-integration-core/__tests__/k3-wise-adapters.test.cjs`
- `docs/development/data-factory-issue1526-wrapper-sql-followup-design-20260519.md`
- `docs/development/data-factory-issue1526-wrapper-sql-followup-verification-20260519.md`

## Local checks

### K3 WISE adapter and SQL executor tests

```bash
node plugins/plugin-integration-core/__tests__/k3-wise-adapters.test.cjs
```

Result: PASS.

- WebAPI adapter tests pass;
- SQL Server channel tests pass;
- SQL read-only executor keeps writes disabled;
- `10.0.0.8,1433` resolves to `server=10.0.0.8`, `port=1433`;
- `sql.local:14330` remains supported;
- conflicting embedded/explicit ports throw `SQLSERVER_PORT_INVALID`.

### Package script syntax

```bash
bash -n scripts/ops/multitable-onprem-package-build.sh
bash -n scripts/ops/multitable-onprem-package-verify.sh
```

Result: PASS. Both commands returned exit code `0`.

PowerShell parser note: `pwsh` is not installed in the local macOS validation
environment, so the `.ps1` file could not be parsed locally with PowerShell.
The Windows-specific behavior is guarded by marker scans, package verify, and
the bridge retest acceptance criteria below.

### Marker checks

```bash
rg --fixed-strings 'CI=true' scripts/ops/multitable-onprem-apply-package.ps1
rg --fixed-strings 'PNPM_CONFIG_CONFIRM_MODULES_PURGE=false' scripts/ops/multitable-onprem-apply-package.ps1
rg --fixed-strings 'Get-DependencyRefreshExitCodeFromLog' scripts/ops/multitable-onprem-apply-package.ps1
rg --fixed-strings 'WaitForExit()' scripts/ops/multitable-onprem-apply-package.ps1
rg --fixed-strings 'SQLSERVER_PORT_INVALID' plugins/plugin-integration-core/__tests__/k3-wise-adapters.test.cjs
```

Result: PASS. All markers are present.

### Package verification guard

```bash
rg --fixed-strings 'PNPM_CONFIG_CONFIRM_MODULES_PURGE=false' scripts/ops/multitable-onprem-package-verify.sh
rg --fixed-strings 'Get-DependencyRefreshExitCodeFromLog' scripts/ops/multitable-onprem-package-verify.sh
rg --fixed-strings 'data-factory-issue1526-wrapper-sql-followup-design-20260519.md' scripts/ops/multitable-onprem-package-build.sh scripts/ops/multitable-onprem-package-verify.sh
```

Result: PASS. Package verify and build manifests require the new safety
markers and docs.

### K3 WISE PoC regression

```bash
pnpm verify:integration-k3wise:poc
```

Result: PASS.

- Live PoC preflight tests: 21/21 pass.
- Evidence compiler tests: 51/51 pass.
- Fixture contract tests: 4/4 pass.
- Mock K3 WebAPI tests: 4/4 pass.
- Mock SQL executor tests: 12/12 pass.
- End-to-end mock PoC chain: PASS.

### Local package build and verify

The clean worktree initially lacked `node_modules`; `pnpm install
--frozen-lockfile` was run once to provide build tools. The resulting
`node_modules` symlink modifications were reverted before final status.

```bash
OUTPUT_DIR=/tmp/ms2-issue1526-wrapper-sql-package \
PACKAGE_TAG=k3wise-issue1526-wrapper-sql-local \
BUILD_WEB=1 \
BUILD_BACKEND=1 \
INSTALL_DEPS=0 \
scripts/ops/multitable-onprem-package-build.sh
```

Result: PASS. The command produced:

- `/tmp/ms2-issue1526-wrapper-sql-package/metasheet-multitable-onprem-v2.5.0-k3wise-issue1526-wrapper-sql-local.zip`
- `/tmp/ms2-issue1526-wrapper-sql-package/metasheet-multitable-onprem-v2.5.0-k3wise-issue1526-wrapper-sql-local.tgz`

```bash
scripts/ops/multitable-onprem-package-verify.sh \
  /tmp/ms2-issue1526-wrapper-sql-package/metasheet-multitable-onprem-v2.5.0-k3wise-issue1526-wrapper-sql-local.zip

scripts/ops/multitable-onprem-package-verify.sh \
  /tmp/ms2-issue1526-wrapper-sql-package/metasheet-multitable-onprem-v2.5.0-k3wise-issue1526-wrapper-sql-local.tgz
```

Result: PASS. Both zip and tgz returned `Package verify OK`.

### Diff hygiene

```bash
git diff --check origin/main...HEAD
```

Result: PASS. No whitespace or conflict-marker issues.

## Bridge retest acceptance

After this lands and a fresh package is published, the entity-machine retest
should record:

1. dependency refresh wrapper starts without a manual `CI=true` workaround;
2. wrapper stdout includes the non-interactive env diagnostic;
3. wrapper stdout includes `pnpm install exit=0`;
4. parent apply log reports exit `0` or explicitly reports use of the wrapper
   exit marker;
5. apply proceeds to migrations, PM2 restart, and healthcheck;
6. SQL Server source test no longer produces a doubled `host,1433:1433`
   resolution failure.

## Safety notes

- No secrets are added to docs or tests.
- The SQL executor remains read-only.
- Real K3 Save / Submit / Audit remains out of scope.
- Customer GATE for WebAPI read/list and relationship runtime remains locked.
