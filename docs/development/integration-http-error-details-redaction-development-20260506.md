# Integration HTTP Error Details Redaction - Development

Date: 2026-05-06
Branch: `codex/integration-error-details-redaction-20260506`

## Goal

Close the remaining REST response redaction gap in `plugin-integration-core` error handling.

## Problem

`plugins/plugin-integration-core/lib/http-routes.cjs` already redacts sensitive payloads for dead-letter reads, but `sendError()` returned `error.details` directly:

```js
details: error.details || undefined
```

Service and adapter errors can carry diagnostic objects that include HTTP headers, tokens, raw vendor payloads, cookies, or credentials. If those errors reached a REST route, the API could return sensitive fields in `error.details` even though the plugin has a shared `sanitizeIntegrationPayload()` helper.

## Implementation

Files changed:

- `plugins/plugin-integration-core/lib/http-routes.cjs`
- `plugins/plugin-integration-core/__tests__/http-routes.test.cjs`

Changes:

- `sendError()` now sanitizes truthy `error.details` through `sanitizeIntegrationPayload()` before writing JSON.
- Existing non-sensitive error metadata remains visible to clients.
- HTTP route coverage now verifies:
  - stable conflict metadata such as `id` remains available;
  - sensitive detail keys such as `password`, `Authorization`, `x-api-key`, `rawPayload`, `token`, and `cookie` are redacted.

## Safety

This is a response-shaping hardening only. It does not change route auth, route registration, service calls, pipeline execution, ERP feedback writes, or adapter behavior.

## Residual Risk

`error.message` is still returned as-is, matching the existing route contract. Callers should continue avoiding secrets in thrown error messages; payload-shaped diagnostics should live in `error.details`, where this patch now applies the shared redaction policy.
