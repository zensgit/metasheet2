# K3 WISE Manual Smoke Workflow Design

## Context

The deploy workflow now runs K3 WISE postdeploy smoke automatically after a successful remote deploy. Operators still need a way to rerun the same smoke without pushing a new commit or redeploying the stack, especially while waiting for the K3 WISE customer GATE packet and when checking whether a configured auth token unlocks the route/staging contract checks.

## Design

This change adds two pieces:

- `scripts/ops/integration-k3wise-postdeploy-summary.mjs`
- `.github/workflows/integration-k3wise-postdeploy-smoke.yml`

The summary script turns the existing smoke evidence JSON into a compact GitHub Step Summary body. The deploy workflow now uses this script instead of inline JavaScript, so the rendering logic is tested and shared.

The new manual workflow runs the existing read-only smoke script through `workflow_dispatch`:

- `base_url`: target MetaSheet URL, default `http://142.171.239.56:8081`
- `require_auth`: when `true`, missing or invalid auth fails the smoke
- `timeout_ms`: per-request timeout

The workflow reads optional secret `METASHEET_K3WISE_SMOKE_TOKEN`. If present, the smoke script automatically runs authenticated checks. If absent and `require_auth=false`, the public checks run and auth-only checks are reported as skipped.

## Failure Model

The manual workflow keeps summary/artifact collection reliable:

- The smoke step records `smoke_rc` and is allowed to continue.
- The summary step runs with `if: always()`.
- The artifact upload step runs with `if: always()`.
- The final step fails the workflow when `smoke_rc != 0`.

This preserves evidence even when the smoke fails.

## Artifact Model

Manual workflow artifacts are uploaded as:

```text
integration-k3wise-postdeploy-smoke-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}
```

Contents:

- `integration-k3wise-postdeploy-smoke.json`
- `integration-k3wise-postdeploy-smoke.md`
- `cli-summary.json`
- `stderr.log`

The workflow is read-only and does not call customer PLM, K3 WISE, SQL Server, staging install, pipeline run, or ERP write APIs.

## Files

- `.github/workflows/docker-build.yml`
- `.github/workflows/integration-k3wise-postdeploy-smoke.yml`
- `scripts/ops/integration-k3wise-postdeploy-summary.mjs`
- `scripts/ops/integration-k3wise-postdeploy-summary.test.mjs`
- `docs/development/integration-k3wise-manual-smoke-workflow-design-20260429.md`
- `docs/development/integration-k3wise-manual-smoke-workflow-verification-20260429.md`
