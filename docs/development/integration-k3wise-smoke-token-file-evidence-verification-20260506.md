# K3 WISE Smoke Token File Evidence Verification

Date: 2026-05-06

## Commands

```bash
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs scripts/ops/integration-k3wise-postdeploy-summary.test.mjs
git diff --check -- scripts/ops/integration-k3wise-postdeploy-smoke.mjs scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs docs/development/integration-k3wise-smoke-token-file-evidence-development-20260506.md docs/development/integration-k3wise-smoke-token-file-evidence-verification-20260506.md
```

## Coverage

The new regression test verifies that a missing `--token-file`:

- exits non-zero
- writes `integration-k3wise-postdeploy-smoke.json`
- writes `integration-k3wise-postdeploy-smoke.md`
- records an `auth-token` failed check
- still records public diagnostic checks
- keeps internal trial signoff blocked

## Result

Passed locally:

- `integration-k3wise-postdeploy-smoke.test.mjs`: 13/13 passed.
- `integration-k3wise-postdeploy-smoke.test.mjs` +
  `integration-k3wise-postdeploy-summary.test.mjs`: 22/22 passed.
- `git diff --check`: passed.
