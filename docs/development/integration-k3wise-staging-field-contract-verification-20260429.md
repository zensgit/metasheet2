# K3 WISE Staging Field Contract Guard Verification - 2026-04-29

## Local Verification

Worktree:

`/tmp/ms2-k3wise-staging-field-contract-20260429`

Branch:

`codex/k3wise-staging-field-contract-20260429`

Commands run:

```bash
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-summary.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs
git diff --check
```

Results:

- `integration-k3wise-postdeploy-smoke.test.mjs`: 11/11 passed.
- `integration-k3wise-postdeploy-summary.test.mjs`: 6/6 passed.
- `integration-k3wise-postdeploy-workflow-contract.test.mjs`: 2/2 passed.
- `git diff --check`: passed.

## Regression Coverage

Added coverage:

- successful authenticated smoke now reports `fieldsChecked` for all required
  staging fields.
- missing `standard_materials.erpSyncStatus` fails
  `staging-descriptor-contract`.
- failure evidence includes `details.missingFields` with the exact missing
  descriptor-field pair.
- GitHub summary rendering includes `missingAdapters`, `missingRoutes`, and
  nested `missingFields` details for failed checks.

Existing coverage preserved:

- public smoke still skips authenticated integration checks when no token is
  provided.
- protected integration routes still skip plugin health instead of failing the
  public-only path.
- authenticated smoke still validates the 15-route integration contract.
- read-only control-plane list probes remain unchanged.
- missing descriptor ID still fails before field validation.

## Mainline Baseline

This work started from `origin/main` at:

`592fe8a6c1ee5bd91f57df97537f35747f0cae8f`

That commit is the merge of PR `#1250`. Its post-merge workflows were checked
before this branch:

- `Phase 5 Production Flags Guard`: success.
- `Deploy to Production`: success.
- `Build and Push Docker Images`: success.
- `Plugin System Tests`: success.
- `.github/workflows/monitoring-alert.yml`: success.

## Residual Risk

The smoke validates descriptor field IDs, not field types or select options.
That is intentional for this slice because the runtime descriptor endpoint
currently exposes field IDs. Type/option validation should either use a richer
descriptor response contract or a plugin-local unit test against
`STAGING_DESCRIPTORS`.
