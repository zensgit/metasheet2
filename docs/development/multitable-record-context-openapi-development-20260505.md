# Multitable Record Context OpenAPI Contract Development - 2026-05-05

## Context

`GET /api/multitable/records/{recordId}` is the record drawer context endpoint.
The runtime response in `packages/core-backend/src/routes/univer-meta.ts`
already returns the permission-aware record context used by the web client:

- `capabilityOrigin`
- `fieldPermissions`
- `viewPermissions` when a view is resolved
- `rowActions`
- `capabilities.canManageSheetAccess`
- `capabilities.canExport`

The OpenAPI schema still described an older shape with `fieldCapabilities` and
`dependencyGraph`, and it omitted the current permission/row-action fields.
That made generated SDK users and contract readers see a stale record drawer
contract.

This PR is intentionally stacked on top of PR #1293 because PR #1293 already
owns the multitable OpenAPI source, generated dist files, and parity test block.
Stacking avoids duplicate generated-file conflicts while #1293 is open.

## Changes

- Updated `MultitableCapabilities` with `canManageSheetAccess` and `canExport`.
- Added schemas for:
  - `MultitableCapabilityOrigin`
  - `MultitableFieldPermission`
  - `MultitableFieldPermissions`
  - `MultitableViewPermission`
  - `MultitableViewPermissions`
  - `MultitableRowActions`
- Updated `MultitableRecordContext` to document the runtime fields:
  - `capabilityOrigin`
  - `fieldPermissions`
  - `viewPermissions`
  - `rowActions`
- Removed stale `fieldCapabilities` and `dependencyGraph` from
  `MultitableRecordContext`.
- Extended `scripts/ops/multitable-openapi-parity.test.mjs` so the runtime
  record-context fields cannot drift silently again.
- Regenerated `packages/openapi/dist/*`.

## Runtime Contract

The documented record context now matches the current route shape:

```json
{
  "sheet": {},
  "view": {},
  "fields": [],
  "record": {},
  "capabilities": {
    "canRead": true,
    "canCreateRecord": true,
    "canEditRecord": true,
    "canDeleteRecord": true,
    "canManageFields": true,
    "canManageSheetAccess": true,
    "canManageViews": true,
    "canComment": true,
    "canManageAutomation": true,
    "canExport": true
  },
  "capabilityOrigin": {
    "source": "sheet-grant",
    "hasSheetAssignments": true
  },
  "fieldPermissions": {
    "fld_name": {
      "visible": true,
      "readOnly": false
    }
  },
  "viewPermissions": {
    "view_grid": {
      "canAccess": true,
      "canConfigure": false,
      "canDelete": false
    }
  },
  "rowActions": {
    "canEdit": true,
    "canDelete": false,
    "canComment": true
  },
  "commentsScope": {},
  "linkSummaries": {},
  "attachmentSummaries": {}
}
```

`view` and `viewPermissions` remain conditional because the endpoint only emits
them when `viewId` resolves. `attachmentSummaries` remains conditional because it
is emitted only when visible attachment fields are present.

## Non-goals

- No backend route behavior changed.
- No frontend type behavior changed; `apps/web/src/multitable/types.ts` was
  already aligned with the runtime shape.
- No attempt was made to move dependency graph or field-capability support into
  the record drawer response. They are not currently returned by the route.
