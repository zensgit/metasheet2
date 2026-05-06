# K3 WISE Signoff Gate Verification

Date: 2026-05-06

## Commands

```bash
node --test scripts/ops/integration-k3wise-signoff-gate.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs scripts/ops/integration-k3wise-postdeploy-summary.test.mjs scripts/ops/integration-k3wise-signoff-gate.test.mjs
git diff --check -- .github/workflows/integration-k3wise-postdeploy-smoke.yml scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs scripts/ops/integration-k3wise-signoff-gate.mjs scripts/ops/integration-k3wise-signoff-gate.test.mjs docs/development/integration-k3wise-signoff-gate-development-20260506.md docs/development/integration-k3wise-signoff-gate-verification-20260506.md
```

## Expected Coverage

The new test suite covers:

- authenticated evidence with all required checks passes
- public-only diagnostic smoke is blocked
- stale explicit signoff pass with `ok=false` is blocked
- stale explicit signoff pass with `summary.fail>0` is blocked
- missing required checks are blocked
- non-passing required checks are blocked
- missing evidence fails by default
- `--help` prints usage
- the manual postdeploy workflow calls the signoff gate when `require_auth=true`

## Result

Passed locally:

- `integration-k3wise-signoff-gate.test.mjs`: 8/8 passed.
- Postdeploy chain suite (`smoke`, `summary`, `workflow-contract`, `signoff-gate`):
  31/31 passed.
- Workflow YAML parse: passed.
- `git diff --check`: passed.
