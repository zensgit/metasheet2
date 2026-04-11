# PLM Yuantus Wave 4 Pact

Date: 2026-04-11

## Scope

Wave 4 extends the Metasheet2 -> Yuantus consumer pact for the next real
mainline calls already present in `PLMAdapter.ts`, limited to:

- `GET /api/v1/eco`
- `GET /api/v1/eco/{id}`
- `GET /api/v1/bom/{bom_line_id}/substitutes`
- `POST /api/v1/bom/{bom_line_id}/substitutes`
- `DELETE /api/v1/bom/{bom_line_id}/substitutes/{substitute_id}`

This intentionally does **not** include the CAD file APIs yet. Those routes are
real, but they require a larger fixture surface and would dilute a fast,
low-risk Wave 4.

The pact count moves from 14 to 19 interactions.

## Why These 5 Endpoints

They are already consumed on `main`:

- approval list: `PLMAdapter.getApprovals()`
- approval detail: `PLMAdapter.getApprovalById()`
- substitute list: `PLMAdapter.getBomSubstitutes()`
- substitute add: `PLMAdapter.addBomSubstitute()`
- substitute remove: `PLMAdapter.removeBomSubstitute()`

This keeps the contract-first rule intact: only freeze surfaces the live
consumer actually calls.

## Design Notes

1. Approval list/detail use the raw ECO routes as they exist today.
`Yuantus` does not currently guarantee fields like `created_by_name` or
`version` on those routes, so Wave 4 does not lock them as required contract
fields.

2. Substitute delete uses a dedicated BOM line fixture.
The provider verifier seeds one BOM line for read, one empty BOM line for add,
and one separate BOM line for delete. That avoids inter-test coupling while
keeping the provider state handler as a no-op.

3. The pact artifact remains canonical in `metasheet2`.
`Yuantus/contracts/pacts/metasheet2-yuantus-plm.json` is still a synchronized
copy, not a second source-of-truth.

## Files Changed

- `packages/core-backend/tests/contract/pacts/metasheet2-yuantus-plm.json`
- `packages/core-backend/tests/contract/plm-adapter-yuantus.pact.test.ts`
- `packages/core-backend/tests/unit/plm-adapter-yuantus.test.ts`
- `packages/core-backend/tests/contract/README.md`
- `docs/development/plm-yuantus-wave4-eco-substitutes-pact-20260411.md`

## Verification

Run from `packages/core-backend`:

```bash
npx vitest run \
  tests/contract/plm-adapter-yuantus.pact.test.ts \
  tests/unit/plm-adapter-yuantus.test.ts
```

Expected result for this wave:

- `2` test files passed
- `28` tests passed

## Deferred To Wave 5

- `GET /api/v1/cad/files/{file_id}/properties`
- `PATCH /api/v1/cad/files/{file_id}/properties`
- `GET /api/v1/cad/files/{file_id}/view-state`
- `PATCH /api/v1/cad/files/{file_id}/view-state`
- `GET /api/v1/cad/files/{file_id}/review`
- `POST /api/v1/cad/files/{file_id}/review`
- `GET /api/v1/cad/files/{file_id}/history`
- `GET /api/v1/cad/files/{file_id}/diff`
- `GET /api/v1/cad/files/{file_id}/mesh-stats`
