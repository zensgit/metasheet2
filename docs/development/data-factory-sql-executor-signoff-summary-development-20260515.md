# Data Factory SQL Executor Signoff Summary Development - 2026-05-15

## Purpose

This slice tightens the operator-facing evidence after the Data Factory
postdeploy smoke reports a configured K3 WISE SQL Server source without a
deployed query executor.

The smoke already emits a non-blocking `sqlserver-executor-availability` check.
Before this change, the GitHub step summary only showed:

```text
`sqlserver-executor-availability`: `skipped`
```

That was technically correct but too quiet for deploy operators. It did not
surface `SQLSERVER_EXECUTOR_MISSING`, the reason text, or the blocked source
system summary.

## Scope

Changed files:

- `scripts/ops/integration-k3wise-postdeploy-summary.mjs`
- `scripts/ops/integration-k3wise-postdeploy-summary.test.mjs`
- `scripts/ops/integration-k3wise-signoff-gate.test.mjs`

This PR intentionally does not implement a real SQL Server executor and does
not change the K3 WISE integration runtime.

## Behavior

### Summary renderer

`integration-k3wise-postdeploy-summary.mjs` now expands skipped details for the
specific optional diagnostic:

```text
`sqlserver-executor-availability`: `skipped`
    - code: `SQLSERVER_EXECUTOR_MISSING`
    - reason: `K3 WISE SQL Server source is configured ...`
    - systemsChecked: `1`
    - blockedSystems: id: `sys_sql`; name: `K3 SQL Source`; role: `source`; status: `error`
```

Only this check gets expanded while skipped. This keeps the summary compact for
ordinary skipped checks while making the advanced SQL-source deployment gap
visible in PR and deploy evidence.

### Nested detail formatting

`formatDetailValue()` now handles arrays of objects recursively. This is needed
for `blockedSystems`, which is emitted as an array of sanitized system
summaries.

Existing string arrays still render the same way, so existing failure details
remain compatible.

### Signoff gate

The signoff gate behavior is unchanged:

- required authenticated checks must still pass;
- `summary.fail` must still be `0`;
- `signoff.internalTrial` must still be `pass`;
- `sqlserver-executor-availability` remains optional and non-blocking.

A regression test locks this behavior so a skipped optional SQL executor
diagnostic does not accidentally block staging-to-K3 internal-trial signoff.

## Why this is the right slice

The current deployment state separates two paths:

- staging/multitable source to K3 target is signoff-ready;
- direct K3 SQL Server source remains an advanced deployment item until the
  bridge machine injects an allowlisted query executor.

This change makes that split readable in evidence without pretending SQL Server
source execution is available.

## Deployment Impact

- No database migration.
- No API contract change.
- No runtime integration-core behavior change.
- No secret-bearing output added.
- Affects only postdeploy evidence rendering and tests.
