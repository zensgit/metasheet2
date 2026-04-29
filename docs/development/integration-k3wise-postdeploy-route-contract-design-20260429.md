# K3 WISE Postdeploy Route Contract Guard Design - 2026-04-29

## Context

The K3 WISE postdeploy smoke already checked public deployment health, plugin
adapter availability, read-only control-plane list probes, and staging descriptor
coverage. Its authenticated route contract was still list-heavy: it did not
require route inventory entries for detail reads or dead-letter replay even
though the integration plugin exposes those routes from
`plugins/plugin-integration-core/lib/http-routes.cjs`.

That created a false-positive deployment risk: `/api/integration/status` could
pass while the operator-facing recovery path was missing from the runtime route
surface.

## Scope

This change tightens only the postdeploy smoke contract. It does not change
runtime route handlers, adapter logic, pipeline execution, credentials, or
production configuration.

Updated guard surface:

- `GET /api/integration/external-systems/:id`
- `GET /api/integration/pipelines/:id`
- `POST /api/integration/dead-letters/:id/replay`

The full required route count is now 15. These routes are intentionally checked
through the plugin status route inventory rather than by mutating live data:

- detail routes prove that the operator can inspect saved external systems and
  pipelines after deployment.
- the replay route proves that the manual recovery control plane is registered.
- list probes remain read-only and continue to avoid side effects on production
  data.

## Implementation

Files changed:

- `scripts/ops/integration-k3wise-postdeploy-smoke.mjs`
  - extends `REQUIRED_ROUTES` with the three missing control-plane routes.
  - preserves token redaction and authenticated-only behavior.
  - includes sanitized failure details in failed check evidence so missing route
    names are actionable without exposing secrets.
- `scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs`
  - extracts the fake status route inventory into `DEFAULT_ROUTES`.
  - asserts the successful route guard checks all 15 routes.
  - adds a regression test for missing dead-letter replay registration.

## Safety

The smoke still performs no write or replay operation against a deployed system.
It validates route registration metadata returned by `/api/integration/status`.
When a route is missing, the evidence file records the missing route name but
continues to redact tokens, authorization headers, and secret-like values.
