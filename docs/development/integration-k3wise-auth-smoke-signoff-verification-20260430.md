# K3 WISE Authenticated Smoke Signoff Verification - 2026-04-30

## Scope

This verifies that K3 WISE postdeploy smoke output can no longer be mistaken for
internal-trial signoff unless authenticated checks actually pass.

## Commands

```bash
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-summary.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs
node --test scripts/ops/resolve-k3wise-smoke-token.test.mjs
git diff --check
```

## Expected

- public-only smoke remains a successful diagnostic run.
- public-only smoke writes `signoff.internalTrial=blocked`.
- authenticated smoke writes `signoff.internalTrial=pass`.
- summary output with `--require-auth-signoff` renders public-only evidence as
  `Internal trial signoff: BLOCKED`.
- manual workflow defaults `require_auth` to `true`.
- deploy workflow summary renders signoff state even when deploy stays in
  diagnostic mode.

## Result

```text
integration-k3wise-postdeploy-smoke.test.mjs             12 passed
integration-k3wise-postdeploy-summary.test.mjs            9 passed
integration-k3wise-postdeploy-workflow-contract.test.mjs  2 passed
resolve-k3wise-smoke-token.test.mjs                       7 passed
git diff --check                                         PASS
```

No customer K3 WISE, PLM, SQL Server, tenant token, or deploy host was used.
