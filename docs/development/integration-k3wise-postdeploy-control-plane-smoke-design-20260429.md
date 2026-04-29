# K3 WISE Postdeploy Control Plane Smoke Design

## Context

The authenticated postdeploy smoke already checked `/api/auth/me`,
`/api/integration/status`, and staging descriptors. That proved the integration
plugin registered the expected adapters and routes, but it did not actually hit
the DB-backed read-only control plane list endpoints.

This left a gap: `/api/integration/status` could pass while a migration,
tenant-scope, or service-wiring issue made `external-systems`, `pipelines`,
`runs`, or `dead-letters` return 500 in the deployed instance.

## Change

`scripts/ops/integration-k3wise-postdeploy-smoke.mjs` now adds four authenticated,
read-only probes when a bearer token is supplied:

- `GET /api/integration/external-systems`
- `GET /api/integration/pipelines`
- `GET /api/integration/runs`
- `GET /api/integration/dead-letters`

Each probe expects HTTP 200 and array-shaped `data`.

Tenant scoping is handled conservatively:

- `--tenant-id <id>` or `METASHEET_TENANT_ID` can provide an explicit tenant.
- Otherwise the smoke derives `tenantId` from `/api/auth/me` if present.
- If neither exists, the probe still runs without a tenant query and the deployed
  API decides whether that token has enough tenant context.

## Safety

The new probes are GET-only. They do not create external systems, pipelines,
runs, dead letters, staging tables, PLM records, K3 WISE documents, or SQL Server
rows.

Public-only smoke behavior is unchanged: without a token, authenticated checks
remain skipped unless `--require-auth` is supplied.
