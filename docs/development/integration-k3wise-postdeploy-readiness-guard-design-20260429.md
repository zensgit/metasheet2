# K3 WISE Postdeploy Readiness Guard Design

## Context

The K3 WISE postdeploy smoke is the operator-facing check that runs after a
MetaSheet deploy and before the customer K3 WISE Live PoC packet is executed.
It must not report authenticated readiness when only the K3 target side is
present. The PoC path depends on the full chain:

- generic HTTP source adapter
- Yuantus PLM wrapper adapter
- K3 WISE WebAPI target adapter
- K3 WISE SQL Server channel adapter
- five user-visible staging multitable descriptors

Before this change, the authenticated route contract required only the two K3
adapter kinds, and the staging contract required only `standard_materials` and
`bom_cleanse`. That was enough to prove a partial ERP target path, but it could
miss a deployment that had lost the PLM/source side or the human repair/audit
staging surfaces.

## Change

`scripts/ops/integration-k3wise-postdeploy-smoke.mjs` now requires all adapter
kinds registered by `plugins/plugin-integration-core/index.cjs`:

- `http`
- `plm:yuantus-wrapper`
- `erp:k3-wise-webapi`
- `erp:k3-wise-sqlserver`

It also requires all staging descriptors authored by
`plugins/plugin-integration-core/lib/staging-installer.cjs` and documented in
`packages/core-backend/claudedocs/integration-plm-k3wise-mvp.md`:

- `plm_raw_items`
- `standard_materials`
- `bom_cleanse`
- `integration_exceptions`
- `integration_run_log`

The checks remain read-only. They still run through:

- `GET /api/integration/status`
- `GET /api/integration/staging/descriptors`

No install, mutation, external PLM call, K3 call, or SQL Server call is added.

## Failure Model

Authenticated postdeploy smoke fails when:

- any required adapter kind is missing from `/api/integration/status`
- any required integration route is missing from `/api/integration/status`
- any required staging descriptor is missing from
  `/api/integration/staging/descriptors`

Unauthenticated public smoke behavior is unchanged. It can still verify public
backend health and the frontend route while marking authenticated contract
checks as skipped unless `--require-auth` is supplied.

## Operator Impact

This makes the deploy signal stricter and more honest:

- public smoke still answers "is the app shell and backend reachable?"
- authenticated smoke now answers "is the deployed integration plugin ready for
  the PLM to staging to K3 PoC chain?"

When customer GATE data arrives, an authenticated postdeploy PASS has higher
value because it covers the source adapter, target adapters, and all user-facing
staging surfaces used by the runbook.

