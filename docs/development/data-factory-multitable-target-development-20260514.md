# Data Factory multitable target adapter - development notes - 2026-05-14

## Purpose

This slice adds a MetaSheet multitable target adapter so cleaned Data Factory records can be materialized into another MetaSheet multitable.

The intended product flow is:

```text
source system / source multitable -> cleansing multitable -> dry-run -> target system / target multitable
```

This keeps the Data Factory centered on multitables as the business cleansing surface. K3 WISE remains one target preset; writing to another multitable is the local target case.

## Adapter

The new adapter kind is:

```text
metasheet:multitable
```

It is target-only:

- `listObjects()` lists configured target tables;
- `getSchema()` returns configured target fields;
- `previewUpsert()` returns the exact multitable payload that dry-run would write;
- `upsert()` writes records through `context.api.multitable.records`;
- `read()` is unsupported.

Example external system config:

```json
{
  "objects": {
    "approved_materials": {
      "name": "Approved Materials",
      "sheetId": "sheet_approved_materials",
      "viewId": "view_approved_materials",
      "openLink": "/multitable/sheet_approved_materials/view_approved_materials",
      "keyFields": ["code"],
      "fields": ["code", "name", "quantity"]
    }
  }
}
```

## Write modes

The adapter supports two object-level modes:

- `upsert` default: if `keyFields` are configured, query the target sheet and patch an existing row; otherwise create a new row.
- `append`: always create a new row.

The pipeline runner passes `_integration_idempotency_key` as its target key field. This adapter deliberately ignores internal `_integration_*` fields by default, because multitable record writes reject unknown field ids. Operators can configure stable business keys such as `code`, `customerCode`, or `externalId` on the target object instead.

## Field projection

When `fields` or `fieldDetails` are configured, only those target fields are written. This prevents internal pipeline metadata and accidental source-only fields from reaching `createRecord()` / `patchRecord()`.

If no field list is configured, the adapter writes all non-internal fields. This fallback is useful for tests and low-code generated tables, but production Data Factory flows should configure explicit target fields.

## Permission boundary

The adapter uses the plugin-scoped multitable API:

```text
context.api.multitable.records.createRecord()
context.api.multitable.records.patchRecord()
context.api.multitable.records.queryRecords()
```

That means writes remain limited by the host plugin scope. This slice does not add a bypass for arbitrary user-owned sheets. General user-selected table write permissions should be a separate kernel/UI permission design if needed.

## Discovery metadata

`GET /api/integration/adapters` now describes `metasheet:multitable` as:

- `roles: ['target']`
- `supports: ['testConnection', 'listObjects', 'getSchema', 'upsert']`
- `guardrails.write.pluginScopedSheetsOnly: true`
- `guardrails.write.supportsAppend: true`
- `guardrails.write.supportsUpsertByKey: true`

## Compatibility with staging sources

This slice was rebased after the staging-source adapter landed on `main`.
The merged runtime now registers both local MetaSheet adapters:

- `metasheet:staging` for read-only cleansing-table sources;
- `metasheet:multitable` for write-only cleansing-output targets.

The two adapters intentionally stay separate instead of becoming a single
bidirectional adapter. This keeps the UI and runner contract explicit: a
staging table used for operator cleansing is not accidentally treated as a
write destination, and a target multitable cannot be selected as a read source
unless a separate source adapter is configured.

## Non-goals

- No new migration.
- No arbitrary user-sheet write permission.
- No K3 live Submit / Audit behavior change.
- No UI wizard for creating a target table in this slice.
- No cross-base sharing or permission grant workflow.

## Deployment impact

Runtime impact is limited to registering one new adapter factory. The adapter performs writes only when a pipeline target system is explicitly configured as `metasheet:multitable`.
