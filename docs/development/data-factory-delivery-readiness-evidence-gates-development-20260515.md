# Data Factory Delivery Readiness Evidence Gates Development - 2026-05-15

## Purpose

The K3 WISE postdeploy smoke can now emit a non-blocking
`sqlserver-executor-availability` diagnostic when a configured K3 SQL Server
source exists but the deployment has not injected the allowlisted
`queryExecutor`.

Before this change, `integration-k3wise-delivery-readiness.mjs` reduced the
postdeploy smoke evidence to pass/fail plus a summary count. That meant a
delivery-readiness artifact could say the internal staging-to-K3 trial was
ready while silently dropping the advanced SQL-source blocker.

This slice carries that diagnostic forward into the final readiness JSON and
Markdown without changing the readiness decision.

It also adds one missing delivery gate: the readiness compiler can now consume
the JSON report emitted by `multitable-onprem-package-verify.sh`. Customer-trial
readiness now requires a verified on-prem package in addition to authenticated
postdeploy smoke and customer GATE preflight evidence.

## Changed Files

- `scripts/ops/integration-k3wise-delivery-readiness.mjs`
- `scripts/ops/integration-k3wise-delivery-readiness.test.mjs`
- `docs/development/data-factory-delivery-readiness-evidence-gates-development-20260515.md`
- `docs/development/data-factory-delivery-readiness-evidence-gates-verification-20260515.md`

## Behavior

### Package verify gate

`integration-k3wise-delivery-readiness.mjs` accepts:

```bash
--package-verify <path>
```

The input is the JSON report written by:

```bash
VERIFY_REPORT_JSON=<path> scripts/ops/multitable-onprem-package-verify.sh <package.zip-or-tgz>
```

The new `package-verify` gate passes only when:

- `ok === true`;
- `checks` is present and non-empty;
- every emitted check has `status === "PASS"`.

If package verify is missing, the gate is `pending` and the decision can still
be `INTERNAL_READY_WAITING_CUSTOMER_GATE`, but it cannot advance to
`CUSTOMER_TRIAL_READY`.

If package verify fails, the overall decision is `BLOCKED`.

### SQL executor diagnostic

When postdeploy smoke includes:

```json
{
  "id": "sqlserver-executor-availability",
  "status": "skipped",
  "code": "SQLSERVER_EXECUTOR_MISSING"
}
```

the postdeploy gate in `integration-k3wise-delivery-readiness.json` now includes:

```json
{
  "advancedSqlSource": {
    "checkId": "sqlserver-executor-availability",
    "status": "skipped",
    "code": "SQLSERVER_EXECUTOR_MISSING"
  }
}
```

The Markdown output adds an `Advanced Diagnostics` table with the same high-level
state.

## Safety Boundary

This does not make SQL Server source execution available. It only preserves the
existing diagnostic in a later artifact.

The readiness decision remains:

- `INTERNAL_READY_WAITING_CUSTOMER_GATE` when authenticated postdeploy smoke
  passes but package verify or customer GATE evidence is still pending;
- `CUSTOMER_TRIAL_READY` only when authenticated postdeploy smoke, package
  verify, and Save-only preflight packet all pass;
- not blocked by an optional skipped SQL executor diagnostic;
- still blocked by real postdeploy failures or unsafe preflight/live evidence.

Only sanitized system summary fields are copied from the smoke check:

- `id`
- `name`
- `role`
- `status`

Connection strings, passwords, and arbitrary source-system config fields are not
copied into the readiness artifact.

## Why This Is Useful

The operator-facing state now says both truths at the same time:

1. staging/multitable source to K3 target can be internally signed off;
2. the on-prem package has or has not been verified;
3. direct SQL Server source remains an advanced bridge-machine deployment task.

That distinction matters when a customer or deploy operator asks whether the
Data Factory path is ready. The answer is no longer flattened into a confusing
single green/red result.

## Deployment Impact

- No database migration.
- No runtime adapter behavior change.
- Adds one CLI option to an ops script: `--package-verify`.
- No API contract change.
- No real SQL executor implementation.
- Affects only the delivery-readiness evidence compiler and tests.
