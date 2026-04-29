# K3 WISE Deploy Authenticated Smoke Verification - 2026-04-29

## Local Verification

Worktree:

`/tmp/ms2-k3wise-deploy-auth-20260429`

Branch:

`codex/k3wise-deploy-auth-smoke-20260429`

Baseline:

`origin/main` at `4dc64b39aebc455b23e87902e6996670acc241c6`

Commands:

```bash
node --test scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-summary.test.mjs
node --test scripts/ops/resolve-k3wise-smoke-token.test.mjs
git diff --check
```

Results:

- `integration-k3wise-postdeploy-workflow-contract.test.mjs`: 2/2 passed.
- `integration-k3wise-postdeploy-smoke.test.mjs`: 12/12 passed.
- `integration-k3wise-postdeploy-summary.test.mjs`: 6/6 passed.
- `resolve-k3wise-smoke-token.test.mjs`: 7/7 passed.
- `git diff --check`: passed.

## Regression Coverage

Added coverage:

- deploy workflow token resolver must be required.
- deploy workflow smoke command must pass `--require-auth`.

Existing coverage preserved:

- manual postdeploy workflow still exposes `require_auth` as an operator input.
- token resolver still supports optional mode for manual diagnostics.
- smoke script still supports public-only mode when callers do not request
  `--require-auth`.

## Residual Risk

This makes production deploy stricter. A deployment missing both
`METASHEET_K3WISE_SMOKE_TOKEN` and a working deploy-host token fallback will
now fail at the K3 WISE smoke phase. That is intentional because otherwise the
deploy can look green while skipping the authenticated checks that validate the
ERP integration surface.
