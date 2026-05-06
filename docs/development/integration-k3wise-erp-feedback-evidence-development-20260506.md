# K3 WISE ERP Feedback Evidence Development - 2026-05-06

## Context

The live PoC evidence compiler previously accepted a `PASS` decision once the
Save-only K3 material write and surrounding phases passed. That proved K3
accepted test records, but it did not prove MetaSheet wrote the ERP result back
to staging rows for operator traceability.

For the customer PoC, feedback writeback is part of the value proposition:
operators need to see ERP sync status, external IDs or bill numbers, response
codes/messages, and sync timestamps in MetaSheet after the K3 Save-only call.

## Change

`scripts/ops/integration-k3wise-live-poc-evidence.mjs` now adds a required
`erpFeedback` phase after `materialSaveOnly`.

Missing `erpFeedback` keeps the report at `PARTIAL`. A passed `erpFeedback`
phase must prove both:

- at least one staging row/item was updated
- feedback field coverage includes:
  - `erpSyncStatus`
  - `erpResponseCode`
  - `erpResponseMessage`
  - `lastSyncedAt`
  - at least one of `erpExternalId` or `erpBillNo`

The validator accepts either row-shaped evidence (`updatedRows`,
`updatedItems`, `items`, `records`) or compact evidence (`rowsUpdated` plus
`fieldsUpdated`/`updatedFields`). This keeps the customer evidence format
flexible while preserving the PASS contract.

## Fixtures

Updated:

- `scripts/ops/fixtures/integration-k3wise/evidence-sample.json`
- `scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs`

The mock PoC demo now synthesizes ERP feedback evidence from the K3 mock adapter
upsert result before compiling the final PASS report.

## Files

- `scripts/ops/integration-k3wise-live-poc-evidence.mjs`
- `scripts/ops/integration-k3wise-live-poc-evidence.test.mjs`
- `scripts/ops/fixtures/integration-k3wise/evidence-sample.json`
- `scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs`
