# PLM Workbench Audit Direct Error Contract Design

Date: 2026-03-29
Commit: pending

## Context

The direct PLM workbench audit routes already return a direct error envelope on server failures:

- `GET /api/plm-workbench/audit-logs`
- `GET /api/plm-workbench/audit-logs/export.csv`
- `GET /api/plm-workbench/audit-logs/summary`

Current backend runtime behavior:

```json
{
  "success": false,
  "error": "Failed to ..."
}
```

But source OpenAPI declared those `500` responses as `ErrorResponse`, which is the structured `ok: false` envelope used by other APIs:

```json
{
  "ok": false,
  "error": {
    "code": "...",
    "message": "..."
  }
}
```

That left three surfaces out of sync:

- backend runtime
- source/dist OpenAPI
- generated `dist-sdk` path types

The handwritten SDK runtime still worked only because `DirectApiEnvelope.error` had already been widened to `string | ApiError`.

## Decision

Introduce a dedicated reusable schema for direct-route string errors:

- `components.schemas.DirectErrorResponse`

Then switch the three PLM workbench audit direct routes to use that schema for `500` responses.

## Why This Fix

- It is the smallest safe contract repair.
- It preserves existing backend behavior and avoids unnecessary runtime churn.
- It makes generated SDK path types match what the server actually returns.
- It removes the mismatch where the SDK runtime was more permissive than the published OpenAPI contract.

## Scope

Included:

- `packages/openapi/src/base.yml`
- `packages/openapi/src/paths/plm-workbench.yml`
- `packages/openapi/dist-sdk/tests/plm-workbench-paths.test.ts`
- `packages/openapi/dist-sdk/tests/client.test.ts`
- `packages/core-backend/tests/unit/plm-workbench-audit-routes.test.ts`

Not included:

- no backend route behavior change
- no frontend UI behavior change
- no broader conversion of other direct routes to structured `ErrorResponse`
