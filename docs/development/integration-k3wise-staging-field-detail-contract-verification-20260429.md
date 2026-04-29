# K3 WISE Staging Field Detail Contract Verification - 2026-04-29

## Local Verification

Worktree:

`/tmp/ms2-k3wise-staging-field-detail-20260429`

Branch:

`codex/k3wise-staging-field-detail-20260429`

Baseline:

`origin/main` at `a01d152bd0a6ede04cc022e75505e011ded94fad`

Commands:

```bash
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-summary.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs
node plugins/plugin-integration-core/__tests__/staging-installer.test.cjs
node plugins/plugin-integration-core/__tests__/http-routes.test.cjs
pnpm --filter @metasheet/web exec vue-tsc --noEmit --project apps/web/tsconfig.app.json --skipLibCheck
git diff --check
```

Results:

- `integration-k3wise-postdeploy-smoke.test.mjs`: 12/12 passed.
- `integration-k3wise-postdeploy-summary.test.mjs`: 6/6 passed.
- `integration-k3wise-postdeploy-workflow-contract.test.mjs`: 2/2 passed.
- `staging-installer.test.cjs`: passed.
- `http-routes.test.cjs`: passed.
- `pnpm --filter @metasheet/web type-check`: passed.
- `git diff --check`: passed.

## Regression Coverage

Added coverage:

- authenticated smoke success reports `fieldDetailsChecked` for every required
  staging field.
- wrong `standard_materials.status` type fails
  `staging-descriptor-contract`.
- incomplete `standard_materials.status` select options fail with exact missing
  option names.
- evidence includes nested `details.invalidFields`.
- summary renderer prints `invalidFields`.
- plugin descriptor summary keeps existing `fields: string[]`.
- plugin descriptor summary exposes `fieldDetails` with select options.
- route test confirms the new metadata is not stripped by the HTTP layer.
- frontend service type accepts the additive field-detail contract.

## Residual Risk

The postdeploy smoke validates only fields that are required by the K3 WISE
PoC staging contract. It does not try to prove every descriptor field property
that multitable provisioning supports. That keeps the guard focused on the
customer-runnable PLM-to-K3 workflow instead of turning it into a broad schema
snapshot test.
