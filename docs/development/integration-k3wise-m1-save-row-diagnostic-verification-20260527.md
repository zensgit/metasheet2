# K3 WISE M1 Save Row Diagnostic Verification - 2026-05-27

## Verification Matrix

| Check | Expected |
| --- | --- |
| Existing row-level validation message | Preserved in the dead-letter message |
| Nested `Data[0].Data` row failure message | Preserved in the dead-letter message |
| Envelope `Successful` with row failure and no row message | Replaced with row-level success-gate failure summary |
| Diagnostic redaction boundary | No raw material identifiers, K3 codes, tokens, host, authorityCode, or connection strings added |
| Save success criteria | Unchanged |
| Submit/Audit/BOM/list boundaries | Unchanged |

## Local Commands

```bash
node plugins/plugin-integration-core/__tests__/k3-wise-adapters.test.cjs
pnpm -F plugin-integration-core test
```

## Current Result

- `node plugins/plugin-integration-core/__tests__/k3-wise-adapters.test.cjs`: PASS.
- `pnpm -F plugin-integration-core test`: PASS.

## Negative Control

The new regression case uses a K3-like response with:

```json
{
  "StatusCode": 200,
  "Message": "Successful",
  "Data": [{ "FStatus": false, "FItemID": 0 }]
}
```

Before the diagnostic change, that path surfaces `Successful` as the row failure message. After the change, the message is a structural row-level success-gate failure summary.

## #1792 Boundary

This verification does not authorize another Save-only attempt. The third M1 attempt remains blocked until customer/operator configuration preview proves the actual Save body includes the reviewed customer-profile fields.
