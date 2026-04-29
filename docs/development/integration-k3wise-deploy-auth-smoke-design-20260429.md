# K3 WISE Deploy Authenticated Smoke Design - 2026-04-29

## Context

The K3 WISE postdeploy smoke has two modes:

- public checks only when no token is available.
- authenticated checks when a bearer token is resolved.

Public-only smoke is useful for diagnostics, but authenticated smoke is needed
when the environment is meant to protect the staging descriptor, route,
adapter, list-probe, and field-detail contracts.

The docker-build deploy job currently runs in environments that may not provide
`METASHEET_K3WISE_SMOKE_TOKEN` or `METASHEET_TENANT_ID`. Making auth mandatory
unconditionally caused the deploy job to fail at token resolution before the
smoke could run. The workflow therefore needs an explicit deployment setting
instead of a hard-coded requirement.

## Design

The deploy workflow now uses one repository variable to choose the deploy
smoke auth mode:

- `K3_WISE_DEPLOY_SMOKE_REQUIRE_AUTH=true` makes token resolution required and
  passes `--require-auth` to the smoke command.
- the default `false` keeps the docker-build deploy job compatible with
  environments that have not configured a K3 smoke token or tenant scope yet.

The manual `K3 WISE Postdeploy Smoke` workflow keeps its explicit
`require_auth` input. Manual operators can still run public-only diagnostics or
force authenticated probes per run.

## Failure Mode

When `K3_WISE_DEPLOY_SMOKE_REQUIRE_AUTH=true`, missing token material remains a
hard failure before the smoke step, and `--require-auth` prevents a public-only
PASS.

When the variable is unset or `false`, the resolver stays best-effort and the
smoke runs public checks. This mode must not be treated as proof that
authenticated K3 control-plane probes ran.

## Files

- `.github/workflows/docker-build.yml`
- `scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs`

## Non-Goals

- This does not change the smoke script itself.
- This does not change the manual diagnostic workflow.
- This does not print or persist tokens beyond the existing masked
  `GITHUB_ENV` handoff.
