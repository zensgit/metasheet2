# Data Factory 142 Postdeploy Smoke Development - 2026-05-14

## Summary

This slice closes the deployment-side verification loop for the Data Factory
postdeploy smoke added in PR #1525.

PR #1525 changed the K3 WISE postdeploy smoke from a K3-only frontend check to
a two-surface check:

- `/integrations/k3-wise`
- `/integrations/workbench`

This follow-up does not change product code. It records the first successful
142 postdeploy run on `main@e8eb9b212`, proving the deployed integration
surface serves both the K3 preset and the default Data Factory workbench.

## Why This Is Needed

The local workstation still cannot reliably use the public HTTP surface on
`142.171.239.56:8081`; direct probes return an empty server reply. SSH from this
environment also lacks a usable key. That makes local workstation smoke
unsuitable as the source of truth for the deployment.

The existing GitHub workflow `K3 WISE Postdeploy Smoke` is the correct
operator path because it uses repository deploy credentials and writes
downloadable, redacted artifacts:

- `integration-k3wise-postdeploy-env-check.json`
- `integration-k3wise-postdeploy-env-check.md`
- `integration-k3wise-postdeploy-smoke.json`
- `integration-k3wise-postdeploy-smoke.md`

## Executed Workflow

Workflow:

- Name: `K3 WISE Postdeploy Smoke`
- Run: `25840155752`
- Event: `workflow_dispatch`
- Head SHA: `e8eb9b212f39bd10ef1e16c3a8a61271012a0977`
- Ref: `main`
- Base URL input: `http://142.171.239.56:8081`
- Auth mode: `require_auth=true`
- Tenant input: `default`

## Result

The workflow completed successfully. The smoke artifact reports:

- `ok=true`
- `authenticated=true`
- `signoff.internalTrial=pass`
- `summary.pass=11`
- `summary.fail=0`
- `summary.skipped=0`

The new Data Factory route check passed:

- `data-factory-frontend-route=pass`

## Deployment Impact

- No database migration.
- No backend route change.
- No frontend route change.
- No K3 WebAPI or SQL Server behavior change.
- No new deployment command.
- This is a release-evidence documentation slice only.
