# K3 WISE Material reference template design - 2026-05-25

## Context

Customer GATE #1792 proved that the K3 WISE service and token path are reachable,
but a minimal Material payload with only `FNumber` / `FName` is not enough for a
positive Save in the tested K3 WISE 15.1 environment.

Direct K3 probes showed two important facts:

- `Material/GetTemplate` models unit, account, and similar master-data fields as
  reference objects.
- `Material/GetList` can return numeric ids for the same conceptual fields, but
  writing those numeric ids back as flat scalars failed with row-level K3
  business errors.

So the next runtime slice is not "write more records". It is to make Material
Save payload construction capable of preserving K3 reference object shape.

## Scope

This PR keeps the scope narrow:

- Material Save payload construction and preview only.
- No BOM write.
- No Submit or Audit.
- No K3 WebAPI read/list runtime.
- No DB migration.
- No real K3 credentials or customer payload examples.

## Design

K3 document schema fields may now declare a reference shape:

```json
{
  "name": "FBaseUnitID",
  "type": "reference",
  "reference": { "identifier": "FNumber" }
}
```

When a target record contains that field:

- a scalar value such as `"PCS"` is rendered as `{ "FNumber": "PCS" }`;
- an object value such as `{ "FID": 1, "FName": "Pcs" }` is preserved as-is;
- blank values are omitted.

This allows customer-confirmed mappings to choose the correct K3 reference
identifier shape without forcing every deployment into the same format.

## Built-in Material Fields

The built-in Material template now exposes the reference/scalar fields that were
surfaced by the customer GATE failure analysis:

- `FUnitGroupID`
- `FBaseUnitID`
- `FOrderUnitID`
- `FSaleUnitID`
- `FProductUnitID`
- `FStoreUnitID`
- `FAcctID`
- `FSaleAcctID`
- `FCostAcctID`
- `FCheckCycle`
- `FTrack`
- `FBatChangeEconomy`
- `FStdBatchQty`
- `FKanBanCapability`

These fields are optional. They only appear in the outbound payload when the
Data Factory mapping or customer-specific configuration supplies values.

## Preview Consistency

The same reference wrapping is applied in three places:

- K3 WebAPI adapter `previewUpsert()`;
- K3 WebAPI adapter `upsert()`;
- template preview helpers used by the K3 setup/Data Factory UI.

This keeps dry-run output aligned with the actual Save request body.

## Safety Boundary

This PR does not make a positive Save possible by itself. It only enables the
correct payload shape once the customer/K3 admin provides valid unit/account
reference values or a known-good redacted Save JSON.

Save-only expansion, BOM, Submit, and Audit remain blocked by the customer GATE.
