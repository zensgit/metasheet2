# Integration Core ERP Feedback Design - 2026-04-24

## Context

K3 WISE adapters can now return target write results, but operators still need
the staging sheet to show whether a cleansed material or BOM reached ERP. This
slice adds the M2-T04 feedback layer:

```text
target adapter upsert result -> normalized ERP feedback -> staging writeback
```

The design is intentionally ERP-neutral. K3 WISE is the first target, but the
module works from the existing adapter `createUpsertResult()` shape.

## Module

Added:

- `plugins/plugin-integration-core/lib/erp-feedback.cjs`
- `plugins/plugin-integration-core/__tests__/erp-feedback.test.cjs`

Changed:

- `plugins/plugin-integration-core/lib/pipeline-runner.cjs`
- `plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs`
- `plugins/plugin-integration-core/index.cjs`

## Standard Fields

Default staging fields follow the current staging installer camelCase schema:

```text
erpSyncStatus
erpExternalId
erpBillNo
erpResponseCode
erpResponseMessage
lastSyncedAt
```

They can be overridden through:

```js
pipeline.options.erpFeedback.fieldMap
```

This allows customer deployments to map to snake_case fields such as
`erp_sync_status` without changing the module.

## Normalization

`normalizeFeedbackItems()` converts target adapter results into feedback items:

```js
{
  key,
  status: 'synced' | 'failed',
  sourceRecord,
  targetRecord,
  fields: {
    erpSyncStatus,
    erpExternalId,
    erpBillNo,
    erpResponseCode,
    erpResponseMessage,
    lastSyncedAt
  }
}
```

Success values are extracted from generic names first:

- `externalId`, `erpExternalId`, `materialId`, `itemId`, `FItemID`
- `billNo`, `billNumber`, `number`, `FBillNo`

K3-style nested raw response paths are also recognized, but the module does not
depend on K3-specific APIs.

Aggregate target failures without itemized `errors[]` are intentionally not
bound to an arbitrary staging row. The runner records one aggregate dead letter
for that case; feedback only writes item-level success/error rows that can be
matched to a clean record.

## Writeback Boundary

`createErpFeedbackWriter()` accepts an injected `stagingWriter`:

```js
stagingWriter.updateRecords({
  tenantId,
  workspaceId,
  runId,
  pipelineId,
  projectId,
  objectId,
  keyField,
  updates
})
```

When no writer is injected, runtime uses `createMultitableFeedbackWriter()` if
`context.api.multitable.provisioning` and `context.api.multitable.records` are
available. It writes only through plugin-scoped multitable APIs:

- resolve object sheet.
- resolve logical field ids to physical ids.
- query existing record by key.
- patch existing record or create a minimal record.

It does not write SQL tables directly.

## Runner Integration

The runner calls ERP feedback immediately after `targetAdapter.upsert()` and
dead-letter handling. Feedback writeback is skipped for dry-runs.

Feedback failures do not roll back target writes and do not fail the pipeline
run by default. The run details capture a compact summary:

```js
details.erpFeedback = [
  {
    ok,
    skipped,
    reason,
    projectId,
    objectId,
    keyField,
    items,
    written
  }
]
```

This keeps ERP data integrity separate from the operator-facing staging update.

## K3 WISE Adapter Result Enrichment

`k3-wise-webapi-adapter.cjs` now includes feedback-friendly fields in each
successful result:

- `externalId`
- `billNo`
- `responseCode`
- `responseMessage`
- `raw`

The adapter contract is unchanged. These are additive fields inside
`createUpsertResult().results[]`.

## Deferred

- real K3 WISE response-code dictionary.
- customer-specific staging object selection.
- bulk multitable patch optimization.
- surfacing feedback summaries in a frontend run-history view.

Strict failure mode is supported with
`pipeline.options.erpFeedback.failOnError === true`, which rethrows staging
writeback errors instead of recording a non-fatal feedback summary.
