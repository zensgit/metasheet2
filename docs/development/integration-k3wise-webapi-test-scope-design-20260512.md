# K3 WISE WebAPI test scope design

## Context

In the K3 WISE setup page, saving a WebAPI external system includes `tenantId` and optional `workspaceId`, but the `测试 WebAPI` button only posted `{ skipHealth }` to:

```text
POST /api/integration/external-systems/:id/test
```

The backend integration test route resolves scope from request body, query, route params, or user context. On on-prem admin sessions where the token does not carry a tenant context, the route returned:

```text
tenantId is required
```

This made the UI look like the K3 connection failed even though the saved system already had the correct scope.

## Change

The setup page now builds a scoped connection-test payload:

```json
{
  "tenantId": "default",
  "workspaceId": null,
  "skipHealth": true
}
```

Both WebAPI and SQL Server test buttons use this scoped payload.

The WebAPI test UI also updates its local connection state immediately from the test response. The page no longer waits for the saved-system list refresh before showing `connected` or `failed`; list refresh runs silently after the result is rendered.

## Why This Shape

- Scope remains explicit and consistent with save/list/run APIs.
- The backend route does not need special on-prem fallback logic.
- The UI becomes responsive even when the post-test list refresh is slow or stale.
- The test result still remains redaction-safe because the backend response already removes credentials.

## Non-Goals

- No backend route changes.
- No K3 adapter behavior changes.
- No migration or package layout changes.
- No automatic live write to K3; this only affects the connection test button.

## Deployment Impact

Frontend-only bug fix. Safe to ship in the next Windows on-prem package.
