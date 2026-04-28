# Integration Test Status Persistence Design - 2026-04-28

## Goal

Make `POST /api/integration/external-systems/:id/test` update the external-system status fields that the new K3 WISE setup page displays:

- `lastTestedAt`
- `lastError`
- `status`

Before this change, a connection test returned `{ ok: ... }` to the caller but did not persist anything. After page refresh, operators could not tell whether the saved ERP/PLM/DB endpoint had ever been tested.

## Backend Behavior

Route changed:

- `plugins/plugin-integration-core/lib/http-routes.cjs`

On test completion:

- successful result clears `lastError`;
- failed result stores a readable `lastError`;
- `lastTestedAt` is set to the current ISO timestamp;
- failed result marks the system `error`;
- successful result marks previous `error`/active systems as `active`;
- successful result preserves `inactive` systems as `inactive`.

The inactive preservation is deliberate. A connection test must not turn a disabled integration into a runnable pipeline dependency.

## Error Handling

Adapters are expected to return `{ ok: false, ... }` for failed tests, but the route now also handles a thrown adapter test error by converting it to a non-throwing test result:

```json
{
  "ok": false,
  "code": "TEST_CONNECTION_FAILED",
  "message": "..."
}
```

This keeps the control-plane UX consistent: clicking Test records the failure instead of losing the result behind a generic 500.

## Response Shape

The route still returns a success envelope:

```json
{
  "ok": true,
  "data": {
    "ok": true,
    "status": 200,
    "system": {
      "id": "...",
      "status": "active",
      "lastTestedAt": "..."
    }
  }
}
```

The returned system is redaction-safe. It strips `credentials` and `credentialsEncrypted`.

## Frontend Behavior

Route:

- `/integrations/k3-wise`

Files:

- `apps/web/src/views/IntegrationK3WiseSetupView.vue`

After a WebAPI or SQL Server test completes, the page reloads saved systems and shows:

- current external-system status;
- last test timestamp;
- last error summary.

## Non-Goals

- No schema change; the columns already exist in `integration_external_systems`.
- No pipeline run behavior change.
- No automatic retry scheduling.
- No direct K3 production write behavior change.
