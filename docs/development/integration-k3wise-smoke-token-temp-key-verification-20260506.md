# K3 WISE Smoke Token Temp Key Verification

Date: 2026-05-06

## Commands

```bash
bash -n scripts/ops/resolve-k3wise-smoke-token.sh
node --test scripts/ops/resolve-k3wise-smoke-token.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-summary.test.mjs
git diff --check -- scripts/ops/resolve-k3wise-smoke-token.sh scripts/ops/resolve-k3wise-smoke-token.test.mjs docs/development/integration-k3wise-smoke-token-temp-key-design-20260506.md docs/development/integration-k3wise-smoke-token-temp-key-verification-20260506.md
```

## Coverage

The resolver tests cover:

- secret-token fast path still writes to `GITHUB_ENV`
- optional auth still skips safely when no inputs are present
- required auth still fails when tenant or deploy SSH inputs are missing
- deploy-host fallback uses SSH without `~/.ssh/deploy_key`
- deploy-host fallback creates a `0600` temp key and removes it before exit

## Result

Passed locally:

- `bash -n scripts/ops/resolve-k3wise-smoke-token.sh`: passed.
- `resolve-k3wise-smoke-token.test.mjs`: 8/8 passed.
- Postdeploy workflow/smoke/summary related tests: 23/23 passed.
- `git diff --check`: passed.
