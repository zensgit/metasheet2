# K3 WISE Postdeploy Tenant Scope Workflow Design

## Context

The authenticated K3 WISE postdeploy smoke can now probe DB-backed read-only
control-plane endpoints. Those endpoints are tenant-scoped. The script supports
`--tenant-id` and `METASHEET_TENANT_ID`, but the GitHub workflow entrypoints did
not expose or pass that scope.

Without the wiring, operators had to rely on `/api/auth/me` carrying tenant
context. That is fine for some JWTs, but brittle for app-admin smoke tokens that
may be intentionally narrow and environment-specific.

## Change

Wire optional tenant scope into both GitHub Actions entrypoints:

- Manual `K3 WISE Postdeploy Smoke` workflow:
  - adds optional `tenant_id` input;
  - falls back to repo variable `METASHEET_TENANT_ID`;
  - passes `--tenant-id` only when the value is non-empty.
- `Build and Push Docker Images` deploy workflow:
  - reads repo variable `METASHEET_TENANT_ID`;
  - passes `--tenant-id` only when the value is non-empty.
- Workflow contract test now asserts this wiring so future YAML edits cannot
  silently drop tenant scope.
- Smoke script tests assert both tenant sources:
  - explicit `--tenant-id` wins over the tenant returned by `/api/auth/me`;
  - `METASHEET_TENANT_ID` is used when the CLI flag is absent.

## Behavior

Public-only smoke remains unchanged. If no token and no tenant scope are
configured, the deployment still runs the two public checks and skips
authenticated checks.

When `METASHEET_K3WISE_SMOKE_TOKEN` is configured, operators can provide tenant
scope via manual input or repo variable and the authenticated smoke will use it
for the read-only list probes.

The tenant scope is carried only into the four read-only control-plane probes:

- `/api/integration/external-systems?tenantId=<tenant>&limit=1`
- `/api/integration/pipelines?tenantId=<tenant>&limit=1`
- `/api/integration/runs?tenantId=<tenant>&limit=1`
- `/api/integration/dead-letters?tenantId=<tenant>&limit=1`

## Non-Goals

- Does not generate or rotate the smoke token.
- Does not force deploy workflow to require auth yet.
- Does not contact customer K3 WISE, PLM, SQL Server, or middleware.
