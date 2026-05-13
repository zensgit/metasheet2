# Generic Integration Workbench Discovery API Design - 2026-05-12

## Purpose

The generic integration workbench needs backend discovery before frontend users can configure mappings safely:

- what adapter kinds are available;
- whether an adapter is a normal business connector or an advanced implementation connector;
- which objects a saved external system exposes;
- which fields a selected object exposes.

This slice adds read-only discovery routes to `plugin-integration-core`. It does not add migrations, does not write pipeline state, and does not run external writes.

## Routes

### `GET /api/integration/adapters`

Returns registered adapter kinds with stable UI metadata:

```json
{
  "kind": "erp:k3-wise-sqlserver",
  "label": "K3 WISE SQL Server Channel",
  "roles": ["source", "target"],
  "supports": ["testConnection", "listObjects", "getSchema", "read", "upsert"],
  "advanced": true
}
```

`advanced: true` is the UI signal to keep SQL channels out of the default business-user connector picker.

### `GET /api/integration/external-systems/:id/objects`

Loads the scoped external system with adapter credentials, creates the adapter, calls `adapter.listObjects()`, and appends valid `config.documentTemplates[]` entries as custom target objects.

Template object output uses:

```json
{
  "name": "supplier",
  "label": "Supplier",
  "operations": ["upsert"],
  "schema": [{ "name": "FNumber", "label": "Supplier code", "type": "string", "required": true }],
  "source": "documentTemplate",
  "template": {
    "id": "custom.supplier.v1",
    "version": "2026.05.v1",
    "bodyKey": "Data",
    "endpointPath": "/api/suppliers/save",
    "source": "custom"
  }
}
```

### `GET /api/integration/external-systems/:id/schema?object=...`

Loads schema for an object:

- if `object` matches a configured document template, returns the template schema without calling adapter `getSchema`;
- otherwise calls `adapter.getSchema({ object })`.

Missing `object` returns `400 OBJECT_REQUIRED`.

## Template Handling

This slice intentionally implements only discovery-safe template normalization:

- `config.documentTemplates` must be an array when present;
- each template must be an object;
- `object` or `targetObject` is required;
- `bodyKey` defaults to `Data`;
- `endpointPath` / `savePath` / `path` must be relative when present;
- `schema[]` entries must contain `name`.

Full template lifecycle validation and preview execution remain in the next slice.

## Security

All discovery responses pass through `sanitizeIntegrationPayload()` before returning. The routes may load adapter credentials internally so that schema discovery can call authenticated vendor endpoints, but credentials are never returned.

SQL channel exposure is metadata-only in this slice. The existing SQL adapter still enforces identifier validation, allowlisted read/write tables, and middle-table write mode.

## Non-Goals

- No template preview API.
- No frontend workbench page.
- No new tables.
- No writes to target systems.
- No raw SQL.
- No user JavaScript.
