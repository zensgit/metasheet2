# Data Factory SQL Executor Diagnostic - Verification - 2026-05-15

## Scope

This verification covers the non-blocking SQL executor diagnostic added after
the #1542 staging-to-K3 postdeploy signoff. The goal is to make
`SQLSERVER_EXECUTOR_MISSING` visible and actionable without turning it into a
false blocker for the staging source path.

## Local Test Matrix

| Area | Command | Expected |
| --- | --- | --- |
| Postdeploy smoke | `node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs` | PASS |
| K3 adapter contract | `pnpm -F plugin-integration-core test` | PASS |
| Workbench UI | `pnpm --filter @metasheet/web exec vitest run apps/web/tests/IntegrationWorkbenchView.spec.ts --watch=false` | PASS |
| Type check | `pnpm --filter @metasheet/web exec vue-tsc --noEmit` | PASS |
| Diff hygiene | `git diff --check origin/main...HEAD` | PASS |

## Executed Results

| Command | Result |
| --- | --- |
| `node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs` | 24/24 PASS |
| `pnpm -F plugin-integration-core test` | PASS |
| `pnpm --filter @metasheet/web exec vitest run tests/IntegrationWorkbenchView.spec.ts --watch=false` | 5/5 PASS |
| `pnpm --filter @metasheet/web exec vue-tsc --noEmit` | PASS |
| `pnpm --filter @metasheet/web build` | PASS, with existing Vite chunk-size/dynamic-import warnings |
| `bash -n scripts/ops/multitable-onprem-package-verify.sh` | PASS |
| `git diff --check origin/main...HEAD` | PASS |
| secret-pattern grep on the new development/verification docs | 0 matches |

Note: an initial `pnpm --filter @metasheet/web exec vitest run
apps/web/tests/IntegrationWorkbenchView.spec.ts --watch=false` attempt failed
because filtered workspace commands run from `apps/web`; the corrected path is
`tests/IntegrationWorkbenchView.spec.ts`.

## Assertions Added

### Adapter contract

- missing executor still returns `ok=false`;
- code remains `SQLSERVER_EXECUTOR_MISSING`;
- message contains both `SQLSERVER_EXECUTOR_MISSING` and `queryExecutor`.

### Workbench UI

- an `erp:k3-wise-sqlserver` source whose `lastError` contains
  `SQLSERVER_EXECUTOR_MISSING` is disabled in the source selector;
- the source selector stays empty;
- the staging setup CTA is still visible;
- the page shows the SQL executor missing hint with the symbolic code.

### Postdeploy smoke

- with a configured SQL source whose status is `error` and whose `lastError`
  contains `SQLSERVER_EXECUTOR_MISSING`, the smoke exits `0`;
- `signoff.internalTrial=pass` is preserved when all required staging/K3 checks
  pass;
- `sqlserver-executor-availability` is emitted as `skipped`;
- the diagnostic reports `code=SQLSERVER_EXECUTOR_MISSING`;
- the diagnostic stores only safe system summaries and does not include
  `lastError` or `queryExecutor` strings in `blockedSystems`;
- with an active SQL source and no last error, the diagnostic is `pass`.

## Artifact Safety

The diagnostic deliberately avoids copying system `config`, SQL connection
strings, token-bearing URLs, or raw `lastError` values into the JSON/Markdown
artifacts. The only system fields written are:

```json
{
  "id": "k3_sql_source_1",
  "name": "K3 SQL Read Channel",
  "role": "source",
  "status": "error"
}
```

## Expected Operator Outcome

For a deployment that has already passed the staging-to-K3 smoke, a skipped
`sqlserver-executor-availability` check means:

- Data Factory can continue using `metasheet:staging` as the source;
- direct K3 SQL Server source execution is not ready;
- the bridge deployment still needs an allowlisted SQL `queryExecutor`;
- after wiring the executor, rerun the smoke and expect the SQL diagnostic to
  move to `pass`.
