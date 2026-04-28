# K3 WISE Postdeploy Smoke Design

## Context

The K3 WISE integration chain now has a deployable setup page, adapter registry, pipeline routes, staging descriptors, and customer-facing preflight/evidence scripts. After each deploy, operators still needed a small repeatable check that answers one question: is the deployed MetaSheet instance ready for the K3 WISE Live PoC path before the customer GATE packet arrives?

## Scope

This change adds `scripts/ops/integration-k3wise-postdeploy-smoke.mjs`.

The script is intentionally a smoke tool, not a live K3 validator:

- It does not connect to customer K3 WISE, PLM, SQL Server, or customer middleware.
- It does not create external systems, pipelines, staging sheets, or ERP records.
- It checks that the deployed MetaSheet surface required by the PoC is reachable and shaped as expected.
- It writes JSON and Markdown evidence under `output/integration-k3wise-postdeploy-smoke/`.

## Check Model

Public checks always run:

- `GET /api/health`: backend is alive and plugin summary reports zero failed plugins.
- `GET /api/integration/health`: integration plugin health, when public on the target deployment.
- `GET /integrations/k3-wise`: K3 WISE setup page route returns the frontend app shell.

Authenticated checks run only when a bearer token is provided:

- `GET /api/auth/me`: supplied token is valid.
- `GET /api/integration/status`: required K3 adapter kinds and integration API routes are registered.
- `GET /api/integration/staging/descriptors`: required K3 PoC staging descriptors exist.

Some deployments protect `/api/integration/*` behind auth. In that case, an unauthenticated `401` or `403` from `/api/integration/health` is reported as `skipped`, not as a deploy failure. Supplying `--auth-token` or `--token-file` makes the plugin health check strict.

## CLI Contract

```bash
node scripts/ops/integration-k3wise-postdeploy-smoke.mjs \
  --base-url http://142.171.239.56:8081 \
  --out-dir output/integration-k3wise-postdeploy-smoke/current-public
```

Optional auth:

```bash
node scripts/ops/integration-k3wise-postdeploy-smoke.mjs \
  --base-url "$METASHEET_BASE_URL" \
  --token-file "$METASHEET_AUTH_TOKEN_FILE" \
  --require-auth
```

Supported environment fallbacks:

- `METASHEET_BASE_URL`, `PUBLIC_APP_URL`
- `METASHEET_AUTH_TOKEN`, `ADMIN_TOKEN`, `AUTH_TOKEN`
- `METASHEET_AUTH_TOKEN_FILE`, `AUTH_TOKEN_FILE`

## Safety

- Token values are never written to stdout, stderr, JSON evidence, or Markdown evidence.
- Response keys matching token/secret/password/authorization/credential are redacted recursively.
- The tool is read-only and uses only `GET` requests.
- `--require-auth` makes missing or invalid auth an explicit failure for operator signoff runs.

## Files

- `scripts/ops/integration-k3wise-postdeploy-smoke.mjs`
- `scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs`
- `docs/development/integration-k3wise-postdeploy-smoke-design-20260428.md`
- `docs/development/integration-k3wise-postdeploy-smoke-verification-20260428.md`
