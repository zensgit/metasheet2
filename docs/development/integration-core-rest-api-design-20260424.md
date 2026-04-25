# Integration Core REST API Design - 2026-04-24

## Context

M1 now has plugin-local registries, adapter contracts, and a pipeline runner.
The next slice adds a thin REST control plane so the frontend and operational
tools can configure and trigger integration work without calling the internal
communication namespace directly.

This REST layer does not own business logic. It delegates to the existing
registries and runner.

## Module

Add:

- `plugins/plugin-integration-core/lib/http-routes.cjs`

`index.cjs` registers the route set during plugin activation after the service
objects are created.

## Routes

Registered routes:

```text
GET  /api/integration/status
GET  /api/integration/external-systems
POST /api/integration/external-systems
GET  /api/integration/external-systems/:id
POST /api/integration/external-systems/:id/test
GET  /api/integration/pipelines
POST /api/integration/pipelines
GET  /api/integration/pipelines/:id
POST /api/integration/pipelines/:id/run
POST /api/integration/pipelines/:id/dry-run
GET  /api/integration/runs
GET  /api/integration/dead-letters
POST /api/integration/dead-letters/:id/replay
```

The existing health endpoint remains:

```text
GET /api/integration/health
```

## Auth And Scope

The route layer expects global auth middleware to populate `req.user`. It still
performs local defensive checks:

- missing user -> `401 UNAUTHENTICATED`
- missing permission -> `403 FORBIDDEN`
- missing tenant -> `400 TENANT_REQUIRED`
- request tenant mismatch with authenticated user's tenant -> `403 TENANT_MISMATCH`
- non-admin users without an authenticated tenant context -> `403 TENANT_CONTEXT_REQUIRED`

Supported permissions:

- read routes: `integration:read`, `integration:write`, `integration:admin`, or admin role
- write routes: `integration:write`, `integration:admin`, or admin role

All service calls receive a normalized `tenantId` and `workspaceId`.

Run and dry-run routes whitelist public fields before calling the runner:

- `tenantId`
- `workspaceId`
- `mode`
- `cursor`
- `sampleLimit`

They do not pass through internal runner fields such as `sourceRecords`,
`allowInactive`, caller-supplied `triggeredBy`, or arbitrary `details`.

## Error Shape

All route errors use:

```json
{
  "ok": false,
  "error": {
    "code": "SOME_CODE",
    "message": "Human-readable message",
    "details": {}
  }
}
```

Successful responses use:

```json
{
  "ok": true,
  "data": {}
}
```

Named service errors are translated before response:

- `*Validation*` -> `400`
- `*NotFound*` -> `404`
- `PipelineRunnerError` -> `422`

## Credential Safety

The route layer never returns plaintext credentials. External-system public
results already expose only credential metadata from the registry:

- `hasCredentials`
- `credentialFormat`
- `credentialFingerprint`

Connection tests use the same internal credential-aware registry method as the
runner, then pass the hydrated system only to adapter construction. Responses
still never include credentials.

Dead-letter list responses omit `sourcePayload` and `transformedPayload` by
default. Admin/integration-admin callers can request payloads with
`includePayload=true`, but payloads still pass through sensitive-key redaction.

## Deferred

- OpenAPI contract generation.
- Frontend wiring.
- Fine-grained RBAC resources beyond `integration:*`.
- Streaming run logs.
