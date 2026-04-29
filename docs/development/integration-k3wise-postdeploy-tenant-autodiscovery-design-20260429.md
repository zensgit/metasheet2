# K3 WISE Postdeploy Tenant Auto-Discovery Design

## Context

The deploy and manual K3 WISE postdeploy smoke workflows can mint a short-lived
JWT from the deploy host backend runtime when no long-lived
`METASHEET_K3WISE_SMOKE_TOKEN` secret is configured. That fallback must sign a
tenant scope into the token and pass the same scope to the authenticated
control-plane list probes.

Before this change, an empty `METASHEET_TENANT_ID` always left the postdeploy
smoke public-only. That is safe, but single-tenant deployments with existing
integration-core data had no guarded way to avoid the manual repo-variable step.

## Change

Add an explicit opt-in tenant auto-discovery path to
`scripts/ops/resolve-k3wise-smoke-token.sh`.

- Default remains fail-closed: `K3_WISE_TOKEN_AUTO_DISCOVER_TENANT=false`.
- When enabled, the deploy-host fallback enters the running backend container
  and reads distinct non-empty tenant ids from:
  - `integration_external_systems`
  - `integration_pipelines`
  - `integration_runs`
  - `integration_dead_letters`
  - `platform_app_instances` scoped to `plugin_id = 'plugin-integration-core'`
- It proceeds only when the combined set contains exactly one tenant id.
- It writes the resolved tenant to `K3_WISE_SMOKE_TENANT_ID` in `GITHUB_ENV`.
- Both workflow smoke steps use
  `${METASHEET_TENANT_ID:-${K3_WISE_SMOKE_TENANT_ID:-}}` when passing
  `--tenant-id`.

## Safety

- Auto-discovery is opt-in in both workflows.
- The source tables are integration-control-plane tables, not customer PLM/K3
  systems.
- Zero candidates still fail closed.
- Multiple candidates fail closed instead of choosing one.
- Generated tokens remain masked and are still scoped to a 2 hour runtime
  expiry by default.
- The deploy workflow keeps auth optional; failed discovery degrades to
  public-only evidence, while manual `require_auth=true` remains a hard gate.

## Operator Flow

Preferred production configuration is still explicit:

1. Set repository variable `METASHEET_TENANT_ID`.
2. Optionally set repository secret `METASHEET_K3WISE_SMOKE_TOKEN`.

Use auto-discovery only when the deployment is known to be a single-tenant
integration environment and the integration-control-plane tables already contain
that tenant:

1. For manual workflow, set `auto_discover_tenant=true`.
2. For deploy workflow, set repo variable
   `K3_WISE_TOKEN_AUTO_DISCOVER_TENANT=true`.

## Non-Goals

- Does not infer tenant from admin users, JWT payloads, request headers, or
  arbitrary defaults.
- Does not make authenticated K3 WISE smoke mandatory for every production
  deploy.
- Does not touch customer K3 WISE, PLM, SQL Server, or middleware.
