# Data Factory Postdeploy Smoke Development - 2026-05-14

## Summary

This slice extends the existing K3 WISE postdeploy smoke so a deployed
MetaSheet instance proves that the main Data Factory route is reachable, not
only the K3 WISE preset route.

The intent is operational: after Windows on-prem deployment, an operator can
run the existing smoke command and see both integration surfaces checked:

- `/integrations/k3-wise` for the K3 WISE preset wizard
- `/integrations/workbench` for the default Data Factory workbench

No backend route, database migration, or integration business behavior changes
were added.

## Files Changed

- `scripts/ops/integration-k3wise-postdeploy-smoke.mjs`
  - Adds a `data-factory-frontend-route` check.
  - Reuses the same app-shell validation used by the K3 WISE frontend route.
  - Keeps authenticated API checks unchanged.
- `scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs`
  - Adds the fake `/integrations/workbench` route.
  - Updates public smoke expectations from 3 to 4 pass checks.
  - Verifies `data-factory-frontend-route` is present and passing.
- `scripts/ops/multitable-onprem-package-build.sh`
  - Includes this development and verification note in the Windows on-prem
    package.
- `scripts/ops/multitable-onprem-package-verify.sh`
  - Verifies the packaged smoke script contains the
    `data-factory-frontend-route` check.

## Behavior

The public smoke path now checks:

1. `/api/health`
2. `/api/integration/health`
3. `/integrations/k3-wise`
4. `/integrations/workbench`

When a token is provided, existing authenticated control-plane checks still run:

- `/api/auth/me`
- `/api/integration/status`
- list probes for systems, pipelines, runs, and dead letters
- staging descriptor contract

## Guardrails

- No external K3 call.
- No SQL call.
- No Save-only push.
- No Submit / Audit behavior.
- No token value written to JSON, Markdown, stdout, or stderr.
- Data Factory smoke remains part of the existing postdeploy command, so the
  deployment procedure does not gain another command to remember.
