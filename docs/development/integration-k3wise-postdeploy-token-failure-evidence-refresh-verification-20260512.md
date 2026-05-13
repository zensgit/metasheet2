# K3 WISE Postdeploy Token Failure Evidence Refresh Verification

Date: 2026-05-12
Branch: `codex/k3wise-postdeploy-token-failure-evidence-refresh-20260512`
Base: `origin/main@fb91f98a9`

## Commands

```bash
node --test scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs
node --check scripts/ops/integration-k3wise-postdeploy-smoke.mjs
node --check scripts/ops/integration-k3wise-postdeploy-env-check.mjs
git diff --check
```

## Expected Coverage

- Deploy token resolver records `token_resolve_rc` without preventing artifact
  collection.
- Deploy env-check records `env_check_rc` and writes `stderr.log` plus
  `cli-summary.json`.
- Deploy smoke runs after a successful remote deploy even when the token/env
  setup is blocked.
- Deploy smoke records `smoke_rc` and writes `stderr.log` plus
  `cli-summary.json`.
- Final deploy gate still fails on any nonzero deploy/token/env/smoke rc after
  summary and artifacts are emitted.

## Results

- `node --test scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs`: 2/2 pass
- `node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs`: 16/16 pass
- `node --check scripts/ops/integration-k3wise-postdeploy-smoke.mjs`: pass
- `node --check scripts/ops/integration-k3wise-postdeploy-env-check.mjs`: pass
- `git diff --check`: pass
