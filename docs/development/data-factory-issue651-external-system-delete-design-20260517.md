# Data Factory issue #651 external-system delete design - 2026-05-17

## Purpose

Close the remaining connector-management gap from issue #651: the Data Factory
inventory showed edit/copy/deactivate controls, but physical delete was still a
disabled UI placeholder because the backend did not expose
`DELETE /api/integration/external-systems/:id`.

This change makes delete real without changing the pipeline model, migrations,
or K3 WISE runtime behavior.

## Scope

Included:

- Add a backend registry method to delete unused external systems.
- Add an HTTP route for `DELETE /api/integration/external-systems/:id`.
- Add frontend service/view wiring so the inventory delete button calls the
  backend and removes the connection from local state.
- Add tests for registry, route, and Data Factory UI behavior.

Excluded:

- No new table or migration.
- No hard delete for connections still referenced by pipelines.
- No K3 WebAPI read/list runtime work.
- No SQL executor or relationship-mapping work.

## Backend Behavior

The delete path is intentionally conservative.

1. Resolve `tenantId`, `workspaceId`, and `id` using the same scoped input path
   as existing external-system routes.
2. Load the row from `integration_external_systems`.
3. Count references in `integration_pipelines` for both:
   - `source_system_id = id`
   - `target_system_id = id`
4. If either count is non-zero, throw `ExternalSystemConflictError`.
5. If there are no references, delete the row with the scoped `WHERE`.
6. Return a public-safe result:

```json
{
  "deleted": true,
  "system": {
    "id": "sys_1",
    "tenantId": "default",
    "workspaceId": null,
    "name": "K3 Target",
    "kind": "erp:k3-wise-webapi",
    "role": "target",
    "status": "inactive",
    "hasCredentials": true,
    "credentialFingerprint": "fp_..."
  }
}
```

Credentials remain write-only. The deleted row is returned through the same
public serializer as `GET` and `LIST`, so plaintext credentials and ciphertext
are not exposed.

## HTTP Contract

New route:

```text
DELETE /api/integration/external-systems/:id?tenantId=default&workspaceId=...
```

Success:

- Status: `200`
- Body: `{ ok: true, data: { deleted: true, system } }`

Failure:

- Missing auth: existing `401` / `403`
- Missing row: `404 ExternalSystemNotFoundError`
- Referenced by pipeline: `409 ExternalSystemConflictError`
- Invalid tenant/scope: existing route guard behavior

Conflict details include:

```json
{
  "referencedPipelineCount": 2,
  "sourcePipelineCount": 1,
  "targetPipelineCount": 1
}
```

## Frontend Behavior

Data Factory inventory now shows a real `删除` button instead of `删除待接口`.

The UI flow:

1. User clicks `删除`.
2. Browser confirm explains that only unreferenced connections can be deleted.
3. UI calls `deleteWorkbenchExternalSystem(system.id, currentScope())`.
4. On success:
   - remove the system from `systems`
   - clear source/target selections if they pointed at the deleted system
   - reset the draft if the draft was editing the deleted system
   - normalize source/target selections
   - show `连接已删除：...`
5. On failure, show the backend error message in the existing status bar.

This keeps #1620's safe-draft model intact: users can still edit/copy/deactivate,
and physical delete is available only when the backend confirms it is safe.

## Compatibility

- Uses existing `integration_external_systems` and `integration_pipelines`.
- Relies on existing migration FK shape:
  `integration_pipelines.source_system_id / target_system_id` reference
  external systems with `ON DELETE RESTRICT`.
- The registry performs a preflight reference count before delete so the user
  receives a clear 409 instead of an opaque DB FK error.
- No public API route is removed or changed.

## Deployment Impact

No migration is required. Existing deployments only need the updated backend and
web bundle. Old clients continue to work because this is additive.

