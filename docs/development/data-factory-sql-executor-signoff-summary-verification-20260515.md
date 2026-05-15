# Data Factory SQL Executor Signoff Summary Verification - 2026-05-15

## Verification Date

2026-05-15T08:09:50Z

## Commands

```bash
node --test scripts/ops/integration-k3wise-postdeploy-summary.test.mjs
node --test scripts/ops/integration-k3wise-signoff-gate.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs
git diff --check origin/main...HEAD
```

## Expected Coverage

### Postdeploy summary renderer

The new test uses authenticated PASS evidence with:

```json
{
  "id": "sqlserver-executor-availability",
  "status": "skipped",
  "code": "SQLSERVER_EXECUTOR_MISSING",
  "systemsChecked": 1,
  "blockedSystems": [
    {
      "id": "sys_sql",
      "name": "K3 SQL Source",
      "role": "source",
      "status": "error"
    }
  ]
}
```

The rendered Markdown must include:

- internal trial signoff remains `PASS`;
- `sqlserver-executor-availability` remains `skipped`;
- `SQLSERVER_EXECUTOR_MISSING` is visible;
- the human reason is visible;
- `systemsChecked` is visible;
- the blocked SQL source summary is visible.

### Signoff gate

The new signoff test confirms:

- all required authenticated checks passing still returns exit code `0`;
- `summary.skipped` can be `1` for the optional SQL executor diagnostic;
- the signoff reason remains
  `authenticated postdeploy smoke satisfies internal-trial gate`.

### Smoke regression

The existing postdeploy smoke test suite remains the source of truth for
emitting the optional diagnostic from real smoke evidence. It is re-run to
ensure the summary/signoff changes did not drift from the smoke output shape.

## Result

| Command | Result |
| --- | --- |
| `node --test scripts/ops/integration-k3wise-postdeploy-summary.test.mjs` | PASS, 16/16 |
| `node --test scripts/ops/integration-k3wise-signoff-gate.test.mjs` | PASS, 9/9 |
| `node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs` | PASS, 24/24 |

`git diff --check origin/main...HEAD` is run after this document is written.
