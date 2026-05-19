# Data Factory SQL Server Read-Only Executor - Verification - 2026-05-19

## Local Scope

Branch:

```text
codex/data-factory-sql-executor-readonly-20260519
```

Files changed:

- `plugins/plugin-integration-core/lib/adapters/k3-wise-sqlserver-executor.cjs`
- `plugins/plugin-integration-core/lib/adapters/k3-wise-sqlserver-channel.cjs`
- `plugins/plugin-integration-core/index.cjs`
- `plugins/plugin-integration-core/__tests__/k3-wise-adapters.test.cjs`
- `plugins/plugin-integration-core/package.json`
- `pnpm-lock.yaml`
- `scripts/ops/multitable-onprem-package-verify.sh`
- `scripts/ops/integration-k3wise-postdeploy-smoke.mjs`
- related SQL executor runbook/test documentation

## Assertions Covered

| Area | Verification |
| --- | --- |
| Runtime injection | `createK3WiseSqlServerChannelFactory({ queryExecutor })` creates SQL channel instances that no longer report missing executor when a runtime executor is supplied. |
| Bounded read query | Fake `mssql` driver captures `SELECT TOP 3 [FItemID], [FNumber], [FName] FROM [dbo].[t_ICItem] ... ORDER BY [FNumber]`. |
| Parameterized filters | `FUseStatus` filter and `FModifyDate` watermark are passed through `request.input()` placeholders. |
| Allowlist still enforced | Existing SQL channel tests continue to reject non-allowlisted read/write tables before the executor runs. |
| Direct write blocked | Existing direct K3 table write block still holds; built-in executor also throws `SQLSERVER_WRITE_EXECUTOR_DISABLED` for `insertMany()`. |
| Secret hygiene | Failing connection results do not serialize the fake password value. |
| Package gate | `multitable-onprem-package-verify.sh` now checks the `mssql` dependency, executor file, runtime injection marker, bounded SELECT marker, and write-disabled marker. |

## Commands

Executed on branch `codex/data-factory-sql-executor-readonly-20260519` after
pinning the runtime dependency to `mssql@10.0.4`:

| Command | Result |
| --- | --- |
| `node -c plugins/plugin-integration-core/lib/adapters/k3-wise-sqlserver-executor.cjs` | PASS |
| `node -c plugins/plugin-integration-core/lib/adapters/k3-wise-sqlserver-channel.cjs` | PASS |
| `node -c plugins/plugin-integration-core/index.cjs` | PASS |
| `bash -n scripts/ops/multitable-onprem-package-build.sh` | PASS |
| `bash -n scripts/ops/multitable-onprem-package-verify.sh` | PASS |
| `pnpm -F plugin-integration-core test:k3-wise-adapters` | PASS |
| `pnpm -F plugin-integration-core test` | PASS |
| `pnpm verify:integration-k3wise:poc` | PASS |
| `node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs` | PASS, 26/26 |
| `node --test scripts/ops/integration-k3wise-postdeploy-summary.test.mjs` | PASS, 16/16 |
| `node --test scripts/ops/integration-k3wise-delivery-readiness.test.mjs` | PASS, 14/14 |
| `node --test scripts/ops/integration-k3wise-signoff-gate.test.mjs` | PASS, 9/9 |
| `git diff --check` | PASS |

Focused SQL executor assertions from
`plugins/plugin-integration-core/__tests__/k3-wise-adapters.test.cjs`:

- packaged SQL adapter factory receives a built-in query executor;
- runtime executor `testConnection()` returns `SQLSERVER_CONNECTED` through
  the real channel shape;
- generated SQL is bounded and structured:
  `SELECT TOP 3 [FItemID], [FNumber], [FName] FROM [dbo].[t_ICItem] ...`;
- `FUseStatus` filter and `FModifyDate` watermark become `request.input()`
  placeholders;
- fake credentials are not exposed in read results or connection failure
  messages;
- built-in executor write attempts fail with
  `SQLSERVER_WRITE_EXECUTOR_DISABLED`.

## Deployment Retest Plan

After the PR is merged and a new Windows/on-prem package is published:

1. Deploy the new package on the bridge/test machine.
2. Run `pnpm install --frozen-lockfile` through the package deploy helper.
3. Confirm `plugins/plugin-integration-core/node_modules/mssql` is installed.
4. Retest the configured K3 WISE SQL Server source from the K3 preset or Data
   Factory page.
5. Expected result:
   - no `SQLSERVER_EXECUTOR_MISSING`;
   - valid config/credentials either connect or return a concrete SQL connection
     error;
   - allowlisted read preview can run for Material/BOM SQL objects;
   - built-in SQL writes remain disabled.

No real K3 Save / Submit / Audit is part of this verification.
