# Data Factory Delivery Readiness Evidence Gates Verification - 2026-05-15

## Verification Date

2026-05-15T08:19:51Z

## Commands

```bash
node --test scripts/ops/integration-k3wise-delivery-readiness.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs
git diff --check
```

## Local Results

| Command | Result |
| --- | --- |
| `node --test scripts/ops/integration-k3wise-delivery-readiness.test.mjs` | PASS, 10/10 |
| `node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs` | PASS, 24/24 |

`git diff --check` is run after this document is written.

## Assertions Added

### Package verify is required for customer trial readiness

The new readiness tests cover:

- package verify PASS plus postdeploy PASS and preflight PASS advances to
  `CUSTOMER_TRIAL_READY`;
- package verify missing leaves the decision at
  `INTERNAL_READY_WAITING_CUSTOMER_GATE`;
- package verify with a non-PASS check blocks readiness;
- CLI accepts `--package-verify` and writes JSON/Markdown artifacts.

### SQL executor diagnostic is preserved

The new readiness test feeds authenticated PASS smoke evidence with:

```json
{
  "id": "sqlserver-executor-availability",
  "status": "skipped",
  "code": "SQLSERVER_EXECUTOR_MISSING",
  "systemsChecked": 1
}
```

Expected result:

- readiness remains `INTERNAL_READY_WAITING_CUSTOMER_GATE`;
- postdeploy gate remains `pass`;
- `advancedSqlSource.status` is `skipped`;
- `advancedSqlSource.code` is `SQLSERVER_EXECUTOR_MISSING`;
- `advancedSqlSource.systemsChecked` is `1`.

### Secret-bearing fields are not copied

The test fixture deliberately includes an extra blocked-system field:

```text
rawConnectionString=server=hidden;credential=should-not-copy
```

Expected result:

- readiness JSON does not include `should-not-copy`;
- Markdown does not include `should-not-copy`;
- only `id`, `name`, `role`, and `status` are copied for blocked systems.

### Markdown explains the split state

The Markdown output includes:

- existing gate table;
- `Advanced Diagnostics` table;
- `SQLSERVER_EXECUTOR_MISSING` under the postdeploy gate.

## Scope Confirmation

This branch does not:

- implement a real SQL Server executor;
- change K3 WebAPI Save-only behavior;
- change customer GATE rules;
- change production readiness rules.
