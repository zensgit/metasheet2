# K3 WISE Material/GetDetail Read-Only Smoke Design - 2026-05-26

## Purpose

This slice implements the smallest runtime unlock for #1709: a read-only smoke
that calls K3 WISE `Material/GetDetail` for one known material number and
harvests the reference objects already present in that detail payload.

It is not a general source connector. It exists to prove that MetaSheet can read
one customer-approved material detail without crossing into Save, Submit, Audit,
BOM, pagination, list reads, broad filters, or server-side pipeline composition.

## Decision

The unlocked runtime surface is:

- Adapter: `erp:k3-wise-webapi`
- Object: `material`
- Operation: `read`, only when the material object is explicitly configured with
  `operations` including `read`
- Endpoint: `POST /K3API/Material/GetDetail`
- Request body:

```json
{
  "Data": {
    "FNumber": "<material-number>"
  },
  "GetProperty": false
}
```

- Response shape: K3 envelope with `Data[0].Data` as the material detail record
- Output: one `createReadResult()` record plus `_k3ReferenceObjects`

The default K3 WISE material template still advertises only `upsert`. This keeps
existing target-only deployments unchanged. Operators must explicitly enable
`read` on the material object before this smoke path runs.

## Runtime Shape

The adapter accepts the material key from either:

- `options.templateMaterialNumber`
- `options.materialNumber`
- `options.number`
- `options.FNumber`
- `filters.templateMaterialNumber`
- `filters.materialNumber`
- `filters.number`
- `filters.FNumber`

The adapter rejects missing or blank keys with `K3_WISE_READ_KEY_REQUIRED`.

The adapter calls `Material/GetDetail` with the same authenticated transport used
by existing WebAPI calls. Login/session handling and authority-code token mode
are reused unchanged.

## Reference Harvesting

The smoke reads the material detail and harvests reference-like objects from the
record into `_k3ReferenceObjects`.

Reference fields are selected by:

- `options.referenceFields` or `filters.referenceFields`, when provided
- otherwise all material template schema fields whose type is `reference`

A value is treated as a reference object when it is an object containing at least
one non-empty reference identifier/name key such as `FNumber`, `FID`, `FId`, or
`FName`.

The customer sample proved that `FUnitGroupID` can return `{ "FName": ... }`
without `FNumber`/`FID`. This implementation accepts that special real-world
shape instead of rejecting it.

## Explicit Non-Goals

This slice does not implement:

- K3 Save, Submit, Audit, or Delete
- BOM reads
- list/search APIs
- pagination or cursor handling
- broad filters or watermark reads
- master-code resolution
- automatic lookup-to-object composition
- server-side pipeline transforms
- Data Factory run orchestration changes

Those remain separately gated. The read-only smoke can feed operator preview and
future one-record regression work, but it does not unlock productionized pipeline
Save composition by itself.

## Error Taxonomy

- `K3_WISE_READ_KEY_REQUIRED`: no concrete material number was supplied
- `K3_WISE_READ_FILTER_UNSUPPORTED`: a broad/list-style filter was supplied
- `K3_WISE_READ_LIST_UNSUPPORTED`: cursor or watermark read was requested
- `K3_WISE_READ_NOT_CONFIGURED`: material read endpoint is absent
- `K3_WISE_READ_FAILED`: transport or non-2xx HTTP failure
- `K3_WISE_READ_BUSINESS_ERROR`: K3 returned a business-negative envelope or no
  material detail row

Errors intentionally identify the failure class without echoing credentials,
tokens, raw connection strings, or request secrets.

## Files

- `plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs`
- `plugins/plugin-integration-core/lib/adapters/k3-wise-document-templates.cjs`
- `plugins/plugin-integration-core/__tests__/k3-wise-adapters.test.cjs`
- `plugins/plugin-integration-core/__tests__/fixtures/k3-wise-material-detail-redacted.json`
