# Data Factory SQL Executor Bridge Handoff - Development - 2026-05-15

## Context

The Data Factory path can now pass internal signoff using `metasheet:staging` as
the source and K3 WISE WebAPI as the target. Direct K3 WISE SQL Server source
execution remains an advanced deployment task because the packaged plugin does
not include a production SQL Server driver or query executor.

The previous slice made the missing executor visible through
`SQLSERVER_EXECUTOR_MISSING`. This slice turns that state into a concrete bridge
handoff for the Windows/on-prem machine.

## Changes

### Operator handoff

Added `docs/operations/integration-k3wise-sql-executor-bridge-handoff.md`.

The handoff documents:

- why the default package reports `SQLSERVER_EXECUTOR_MISSING`;
- where the executor is expected to be injected;
- the required `testConnection`, `select`, and `insertMany` methods;
- read and middle-table write constraints;
- what belongs in JSON config versus secret storage;
- how to verify the bridge wiring through postdeploy smoke;
- what Claude Code may safely do on the bridge machine.

### Package inclusion

Updated `scripts/ops/multitable-onprem-package-build.sh` so the handoff is
included in the Windows/on-prem package.

Updated `scripts/ops/multitable-onprem-package-verify.sh` so package verification
fails if the handoff is absent or loses the key executor contract terms.

Updated `scripts/ops/multitable-onprem-delivery-bundle.mjs` so customer/operator
delivery bundles include the same bridge-machine handoff material as the package.

### Cross-link

Updated `docs/operations/integration-k3wise-internal-trial-runbook.md` to point
operators from the smoke's `SQLSERVER_EXECUTOR_MISSING` diagnostic to the bridge
handoff.

Updated `docs/development/k3wise-bridge-machine-codex-handoff-20260513.md` with
the same bridge-machine execution boundary so a new Codex session on the bridge
does not infer that mock SQL support is production-ready.

## Non-goals

- No `mssql` or `tedious` dependency was added.
- No production query executor implementation was added.
- No new API, route, migration, or runtime write path was added.
- No customer SQL Server connection is attempted from development machines.

## Deployment Impact

This is a documentation and package-contract change only. It prepares the bridge
machine implementation work without changing current MetaSheet behavior.

Once deployed, operators will see the handoff inside the on-prem package and can
use it to wire the deployment-owned SQL executor safely.
