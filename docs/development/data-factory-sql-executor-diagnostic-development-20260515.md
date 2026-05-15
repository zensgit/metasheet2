# Data Factory SQL Executor Diagnostic - Development Notes - 2026-05-15

## Context

Issue #1542 is now resolved for the Data Factory staging-to-K3 metadata path:
staging install, `standard_materials` schema discovery, K3 material schema
discovery, and draft pipeline save pass in postdeploy smoke.

The remaining operator confusion is different: a configured
`erp:k3-wise-sqlserver` source can still show `SQLSERVER_EXECUTOR_MISSING`
because the deployment has not injected the allowlisted SQL executor. That is an
advanced-source deployment gap, not a failure of the staging-to-K3 signoff path.

## Changes

### Backend adapter message

`plugins/plugin-integration-core/lib/adapters/k3-wise-sqlserver-channel.cjs`
now prefixes the missing-executor test result message with the symbolic code:

```text
SQLSERVER_EXECUTOR_MISSING: inject queryExecutor ...
```

The code already existed in the immediate test result. Prefixing the message
keeps the same API shape while making persisted `lastError` entries actionable
after `/external-systems/:id/test` updates the system status.

### Workbench detection

`apps/web/src/views/IntegrationWorkbenchView.vue` now explicitly recognizes
`SQLSERVER_EXECUTOR_MISSING` in addition to the existing `queryExecutor`,
`executor`, `injected`, `注入`, and `执行器` text. The disabled SQL-source hint
also includes the symbolic code so operators and implementers can cross-check
UI, smoke artifacts, and backend logs.

### Postdeploy smoke diagnostic

`scripts/ops/integration-k3wise-postdeploy-smoke.mjs` adds a non-blocking
`sqlserver-executor-availability` check:

- no configured `erp:k3-wise-sqlserver` source: no check is emitted;
- configured SQL source active: check is `pass`;
- configured SQL source unavailable or code-matched missing executor: check is
  `skipped`.

The skipped state is deliberate. It records the deployment gap without blocking
`signoff.internalTrial=pass` for the staging-to-K3 path. The check stores only
safe system summaries (`id`, `name`, `role`, `status`) and does not write
`lastError` or connection config into artifacts.

### Operator runbook and package guard

`docs/operations/integration-k3wise-internal-trial-runbook.md` now explains how
to interpret `SQLSERVER_EXECUTOR_MISSING`: use `metasheet:staging` as the source
for #1542 retests, wire the SQL `queryExecutor` on the bridge deployment before
direct SQL source execution, then rerun the smoke.

`scripts/ops/multitable-onprem-package-verify.sh` now guards that the on-prem
package continues to include both the runbook disposition and the smoke
diagnostic.

## Deployment Impact

- No migration.
- No runtime behavior change for WebAPI, staging, dry-run, Save-only, Submit, or
  Audit.
- SQL Server source remains advanced and unavailable until a real query executor
  is deployed.
- Postdeploy smoke may include one additional skipped/pass diagnostic only when
  SQL Server source systems are configured.

## Claude Code

Claude Code is not required for this slice. It is repo-local and fully covered by
unit/smoke tests. Claude Code or a bridge-machine operator is only useful for the
separate task of wiring a real SQL Server `queryExecutor` in the Windows/K3
network.
