# Data Factory Issue 1542 Pipeline Save Development Notes - 2026-05-15

## Context

Issue #1542 started as a Data Factory onboarding gap, then exposed two deploy-time blockers while testing the staging-to-K3 material pipeline:

- `POST /api/integration/pipelines` returned HTTP 500 with PostgreSQL code `22P02` and `invalid input syntax for type json`.
- A manually created `metasheet:staging` external system could connect, but `standard_materials` schema discovery returned `fields: []`.

The SQL Server source executor is still intentionally outside this patch. That lane needs a separate product decision because direct SQL access must stay behind the advanced connection guardrails.

## Root Cause

The pipeline registry writes several structured fields into JSONB columns:

- `integration_pipelines.idempotency_key_fields`
- `integration_pipelines.options`
- `integration_field_mappings.transform`
- `integration_field_mappings.validation`
- `integration_field_mappings.default_value`
- `integration_runs.details`

`node-postgres` treats JavaScript arrays as PostgreSQL array literals when they are passed as bind parameters. A value such as `['sourceId', 'revision']` therefore reaches PostgreSQL as an array literal, not JSON text, and fails when the destination column is JSONB.

There was also a nearby primitive JSONB risk: `default_value` can be a string such as `PCS`. That must be stored as JSON text `"PCS"`, not as the raw SQL parameter `PCS`.

The staging source schema issue came from manual system creation. The workbench-created path includes `fields` / `fieldDetails`, but the manually-created path only provided `sheetId`. The adapter had no fallback to the plugin-owned staging descriptor catalog.

## Changes

### Pipeline JSONB Writes

`plugins/plugin-integration-core/lib/pipelines.cjs` now serializes JSONB-owned columns before they reach the scoped DB helper:

- Arrays become JSON text, for example `["sourceId","revision"]`.
- Objects become JSON text, for example `{"batchSize":100}`.
- Primitive default values become valid JSON text, for example `"PCS"`.
- Row hydration accepts either parsed JSONB values from PostgreSQL or JSON text from tests/fakes.

This keeps the JSONB ownership visible at the pipeline registry boundary instead of relying on driver-specific behavior.

### Scoped DB Defense

`plugins/plugin-integration-core/lib/db.cjs` also serializes array/plain-object bind values before calling the host database. This is defense in depth for other integration tables that store JSONB values through the same CRUD helper.

The DB helper still exposes no raw SQL path. Identifier validation and parameterized statements are unchanged.

### Staging Schema Fallback

`plugins/plugin-integration-core/lib/adapters/metasheet-staging-source-adapter.cjs` now derives known staging object fields from `listStagingDescriptors()` when a config object omits explicit `fields` / `fieldDetails`.

For example, this manual config is now sufficient for schema discovery:

```json
{
  "objects": {
    "standard_materials": {
      "sheetId": "sheet_materials"
    }
  }
}
```

The adapter still rejects unknown objects and still requires `context.api.multitable.records.queryRecords()` for reads.

## Compatibility

- No new migration.
- No API shape change.
- Existing workbench-created staging source configs continue to use their explicit field metadata.
- Existing pipeline read responses continue to return parsed arrays/objects/primitives.
- The SQL executor missing state remains unchanged and should continue to be shown as an advanced-source blocker rather than silently attempted.
