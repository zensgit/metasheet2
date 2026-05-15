# Data Factory Issue 1542 Pipeline Save Verification - 2026-05-15

## Scope

This verification covers the P0 parts of issue #1542:

- Pipeline save no longer emits JSONB `22P02` for array/object/string JSON values.
- Manual `metasheet:staging` source configs can discover known staging object schemas.

It does not claim SQL Server source execution is available. `SQLSERVER_EXECUTOR_MISSING` remains a separate advanced-connection gap.

## Local Regression Commands

```bash
node plugins/plugin-integration-core/__tests__/db.test.cjs
node plugins/plugin-integration-core/__tests__/pipelines.test.cjs
node plugins/plugin-integration-core/__tests__/metasheet-staging-source-adapter.test.cjs
```

Result:

```text
PASS db.cjs: all CRUD + boundary + injection tests passed
PASS pipelines: registry + endpoint + field-mapping + run-ledger + concurrent-guard + stale-run-cleanup tests passed
PASS metasheet-staging-source-adapter: read-only multitable source tests passed
```

## Assertions Added

### DB Helper

- `idempotency_key_fields: ['sourceId', 'revision']` is passed to the host DB as JSON text.
- `options: { k3Template: { id: 'material', version: 1 } }` is passed to the host DB as JSON text.
- Existing SQL-injection and identifier-boundary tests remain green.

### Pipeline Registry

- Pipeline insert stores `idempotency_key_fields` as `["sourceId","revision"]`.
- Pipeline insert stores `options` as `{"batchSize":100}`.
- Field mapping string default stores as `"PCS"` for JSONB validity.
- Field mapping object/array values store as JSON text.
- Pipeline output hydrates JSON text back into the public response shape.
- Pipeline run `details` stores as JSON text and hydrates back to an object.

### Staging Source Adapter

- Manual config with only `objects.standard_materials.sheetId` now returns a non-empty schema.
- The fallback includes known material fields such as `code` and `name`.
- Existing read-only paging behavior remains unchanged.

## Manual Retest Recipe for the Deployed Box

After deploying a package containing this patch:

1. Ensure the `metasheet:staging` adapter is present in `/api/integration/adapters`.
2. Create or use a staging source with `objects.standard_materials.sheetId`.
3. Call schema discovery for `standard_materials`; it should return fields instead of `[]`.
4. Save a minimal `metasheet:staging -> erp:k3-wise-webapi` material pipeline with:

```json
{
  "idempotencyKeyFields": ["code"],
  "options": {
    "k3Template": {
      "id": "material",
      "version": 1,
      "documentType": "material"
    }
  },
  "fieldMappings": [
    {
      "sourceField": "code",
      "targetField": "FNumber",
      "validation": [{ "type": "required" }]
    },
    {
      "sourceField": "uom",
      "targetField": "FBaseUnitID",
      "defaultValue": "PCS"
    }
  ]
}
```

Expected result:

- HTTP 200/201 for pipeline save.
- No PostgreSQL `22P02`.
- Returned pipeline contains parsed `idempotencyKeyFields`, `options`, `validation`, and `defaultValue`.

## Remaining Issue Notes

- SQL Server source still needs a real injected `queryExecutor` or a disabled-state UX that explains why direct SQL read is unavailable.
- This patch unblocks the staging-to-K3 path; it does not broaden direct SQL privileges.
