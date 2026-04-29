# K3 WISE Postdeploy Workflow Design

## Context

`scripts/ops/integration-k3wise-postdeploy-smoke.mjs` made the K3 WISE postdeploy check repeatable, but it still required a human to remember to run it after the main deployment workflow. The next step is to wire the check into the existing `Build and Push Docker Images` deploy job so every successful main deploy leaves a K3 WISE integration smoke artifact.

## Design

The workflow integration is intentionally narrow:

- It runs only after `Remote deploy (with preflight logs)` reports `deploy_rc=0`.
- It executes from the GitHub runner against the public app URL, not from the deploy host.
- It uses the existing read-only K3 WISE smoke script.
- It writes evidence under `output/deploy/k3wise-postdeploy-smoke/`, so the existing `Upload deploy artifacts` step includes the JSON and Markdown smoke outputs.
- It appends a compact K3 WISE section to `GITHUB_STEP_SUMMARY`.

## Auth Model

The default path is public-only:

- backend health
- K3 WISE frontend route
- protected `/api/integration/*` checks are reported as skipped when no token is available

If repository secret `METASHEET_K3WISE_SMOKE_TOKEN` is configured, the same step automatically runs the authenticated contract checks:

- `/api/auth/me`
- `/api/integration/status`
- `/api/integration/external-systems?tenantId=<tenant>&limit=1`
- `/api/integration/pipelines?tenantId=<tenant>&limit=1`
- `/api/integration/runs?tenantId=<tenant>&limit=1`
- `/api/integration/dead-letters?tenantId=<tenant>&limit=1`
- `/api/integration/staging/descriptors`

The deploy workflow reads optional repo variable `METASHEET_TENANT_ID` and passes
it as `--tenant-id` when non-empty. The manual `K3 WISE Postdeploy Smoke`
workflow can also receive `tenant_id` as an input and falls back to the same repo
variable.

The deploy workflow does not pass `--require-auth`; missing auth is acceptable
for the baseline deploy gate. A bad configured token still fails the smoke
because the script treats supplied auth as strict. The manual workflow can set
`require_auth=true` for operator signoff runs.

## Failure Behavior

The K3 WISE smoke is a normal failing step. If public health or the app route regresses, the deploy job fails even though the remote deploy command itself may have returned `0`.

The deploy summary keeps the remote deploy stage status separate from the K3 WISE postdeploy smoke status, making it clear whether a failure came from:

- remote deploy/preflight/migrate/smoke
- or the K3 WISE app-surface smoke that runs afterward

## Artifact Handling

Committed:

- `.github/workflows/docker-build.yml`
- `.gitignore`
- `docs/development/integration-k3wise-postdeploy-workflow-design-20260429.md`
- `docs/development/integration-k3wise-postdeploy-workflow-verification-20260429.md`

Generated and ignored:

- `output/deploy/k3wise-postdeploy-smoke*/`

The ignored path can include authenticated evidence and deployment topology, so it should remain an artifact output rather than a tracked repository file.
