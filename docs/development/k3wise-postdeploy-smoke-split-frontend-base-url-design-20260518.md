# K3 WISE Postdeploy Smoke Split Frontend Base URL Design - 2026-05-18

## Context

Issue #651 reported that the current Windows on-prem package deployed and the
backend/auth/staging/Data Factory smoke checks passed, but the frontend route
checks still failed:

- `/integrations/k3-wise` returned 404
- `/integrations/workbench` returned 404

The package already contains the frontend bundle and the nginx example already
contains SPA history fallback. The remaining likely deployment shape is that
operators are running the smoke with an API/control-plane URL, while the SPA is
served by a different nginx/front-door URL.

The previous smoke contract had one URL:

```text
--base-url
```

That made API checks and frontend route checks inseparable.

## Goal

Allow the same postdeploy smoke to validate deployments where:

- API/control-plane checks use one origin.
- Frontend SPA route checks use another origin.
- Existing deployments that use one origin keep working unchanged.

## Scope

Changed files:

- `.github/workflows/integration-k3wise-postdeploy-smoke.yml`
- `.github/workflows/docker-build.yml`
- `scripts/ops/integration-k3wise-postdeploy-smoke.mjs`
- `scripts/ops/integration-k3wise-postdeploy-env-check.mjs`
- `scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs`
- `scripts/ops/integration-k3wise-postdeploy-env-check.test.mjs`
- `scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs`
- `docs/operations/integration-k3wise-internal-trial-runbook.md`
- `docs/deployment/multitable-windows-onprem-easy-start-20260319.md`

No frontend route, backend route, migration, K3 adapter, pipeline, Save,
Submit, Audit, or Data Factory runtime behavior changed.

## CLI Contract

`integration-k3wise-postdeploy-smoke.mjs` now accepts:

```text
--base-url <url>
--frontend-base-url <url>
```

`--base-url` is the API/control-plane base URL. It is used for:

- `/api/health`
- `/api/integration/health`
- `/api/auth/me`
- integration route/status/list checks
- staging descriptor/install checks
- issue #1542 workbench smoke API checks

`--frontend-base-url` is the frontend/nginx SPA base URL. It is used only for:

- `/integrations/k3-wise`
- `/integrations/workbench`

If `--frontend-base-url` is omitted, it defaults to `--base-url`.

## Environment Fallbacks

The scripts now distinguish API and frontend env values:

```text
METASHEET_BASE_URL
METASHEET_FRONTEND_BASE_URL
PUBLIC_APP_URL
FRONTEND_BASE_URL
```

`METASHEET_BASE_URL` remains the API/control-plane URL.
`METASHEET_FRONTEND_BASE_URL`, `PUBLIC_APP_URL`, or `FRONTEND_BASE_URL` can
provide the frontend URL.

The deploy workflows continue to populate `METASHEET_BASE_URL` from existing
variables. They now also pass `METASHEET_FRONTEND_BASE_URL` when configured.

## Failure Semantics

Frontend 404 remains a failed smoke check. The change does not mask an actual
missing frontend route.

When API checks pass but frontend route checks return 404, the artifact now
keeps the failure actionable:

- `code: FRONTEND_ROUTE_NOT_FOUND`
- likely cause: backend-only/API URL or missing SPA fallback
- hint: use `--frontend-base-url` for the frontend/nginx URL when it differs
  from `--base-url`

This preserves the signoff gate while helping operators fix the URL selection
instead of guessing whether the frontend was packaged.

## Workflow Contract

Manual workflow:

- Adds optional `frontend_base_url` dispatch input.
- Passes `--frontend-base-url` to the input check and smoke only when supplied.

Deploy workflow:

- Adds `METASHEET_FRONTEND_BASE_URL` env from
  `vars.METASHEET_FRONTEND_BASE_URL || vars.PUBLIC_APP_URL ||
  vars.METASHEET_BASE_URL || ''`.
- Passes `--frontend-base-url` to the input check and smoke only when non-empty.

## Operator Guidance

Use one URL when nginx serves both API and SPA:

```bash
node scripts/ops/integration-k3wise-postdeploy-smoke.mjs \
  --base-url "http://<nginx-host>" \
  --token-file "<admin-token-file>" \
  --tenant-id default \
  --require-auth
```

Use split URLs when the API and SPA are exposed separately:

```bash
node scripts/ops/integration-k3wise-postdeploy-smoke.mjs \
  --base-url "http://<api-host-or-port>" \
  --frontend-base-url "http://<frontend-nginx-host>" \
  --token-file "<admin-token-file>" \
  --tenant-id default \
  --require-auth
```

## Risk

Risk is low:

- Existing one-URL deployments keep the old behavior.
- Split URL only changes the two frontend route probes.
- The route checks still fail on 404.
- URL validation keeps rejecting credentials, query strings, and hashes.

