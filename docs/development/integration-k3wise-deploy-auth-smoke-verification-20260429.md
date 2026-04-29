# K3 WISE Deploy Authenticated Smoke Verification - 2026-04-29

## Local Verification

Worktree:

`/tmp/ms2-k3wise-deploy-auth-fix-20260429`

Branch:

`codex/k3wise-deploy-auth-fix-20260429`

Baseline:

`origin/main` at `e6e585fad2411adc06db4c0132bd3e84c2660326`

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

Updated coverage:

- deploy workflow token resolver must read
  `K3_WISE_TOKEN_RESOLVE_REQUIRED` from
  `vars.K3_WISE_DEPLOY_SMOKE_REQUIRE_AUTH || 'false'`.
- deploy workflow smoke command must read
  `K3_WISE_DEPLOY_SMOKE_REQUIRE_AUTH`.
- deploy workflow smoke command only passes `--require-auth` when that setting
  is truthy (`true`, `TRUE`, `True`, `1`, `yes`, `YES`, `Yes`).

Existing coverage preserved:

- manual postdeploy workflow still exposes `require_auth` as an operator input.
- token resolver still supports optional mode for manual diagnostics.
- smoke script still supports public-only mode when callers do not request
  `--require-auth`.

## Residual Risk

Docker-build deploy remains public-smoke by default until the repository or
environment sets `K3_WISE_DEPLOY_SMOKE_REQUIRE_AUTH=true`. The residual risk is
that a green deploy in default mode does not prove authenticated K3 control
plane checks ran. The run summary and artifacts should be used to distinguish
public-only evidence from authenticated evidence.

When `K3_WISE_DEPLOY_SMOKE_REQUIRE_AUTH=true`, a deployment missing both
`METASHEET_K3WISE_SMOKE_TOKEN` and a working deploy-host token fallback will
fail before or during the K3 WISE smoke. That is intentional for environments
that have opted into authenticated deploy gating.
