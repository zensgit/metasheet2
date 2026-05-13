# K3 WISE Smoke Token File Evidence Refresh Verification

Date: 2026-05-12
Branch: `codex/k3wise-smoke-token-file-evidence-refresh-20260512`
Base: `origin/main@72bf68f49`

## Commands

```bash
node --check scripts/ops/integration-k3wise-postdeploy-smoke.mjs
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs
git diff --check
```

## Expected Coverage

- Missing token-file path is captured as `checks[].id === "auth-token"`.
- Public probes still run, so the evidence distinguishes "token unavailable"
  from "deployment unavailable".
- Required-auth mode still fails the run because authenticated checks cannot
  execute.
- JSON and Markdown evidence are written even when the token file is missing.

## Results

- `node --check scripts/ops/integration-k3wise-postdeploy-smoke.mjs`: pass
- `node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs`: 16/16 pass
- `node --test scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs`: 2/2 pass
- `git diff --check`: pass

## Regression Details

The new missing-token-file test proves:

- CLI exits `1`.
- `stdout` remains valid JSON with `ok: false`, `authenticated: false`, and
  `summary.fail === 2`.
- `integration-k3wise-postdeploy-smoke.json` is written.
- `integration-k3wise-postdeploy-smoke.md` is written.
- Evidence contains `auth-token: fail`, `api-health: pass`, and
  `authenticated-integration-contract: fail`.
