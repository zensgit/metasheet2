# Multitable View Contract Gate Alignment

Date: 2026-03-26  
Branch: `codex/multitable-next`

## Goal

Lock the already-aligned `ViewManager` CRUD/form contract slice into the canonical pilot gate and OpenAPI parity suite.

## Why

The previous clean slices fixed runtime drift for:

- `GET /api/multitable/views`
- `POST /api/multitable/views`
- `PATCH /api/multitable/views/{viewId}`
- `DELETE /api/multitable/views/{viewId}`
- `POST /api/multitable/views/{viewId}/submit`

But the release gate still only exercised:

- `tests/multitable-embed-route.spec.ts`
- `tests/multitable-client.spec.ts`

That meant a future regression in `ViewManager` contract bridging could still slip past the pilot-ready gate even though the runtime and OpenAPI had already been aligned.

## Design

### Extend the canonical web contract gate

Add `tests/view-manager-multitable-contract.spec.ts` to the `web.vitest.multitable.contracts` step in:

- `scripts/ops/multitable-pilot-release-gate.sh`

Keep it in the contract bucket instead of the broad workbench bucket because it validates runtime shape and endpoint mapping, not interactive UI behavior.

### Keep the gate test in sync

Update `scripts/ops/multitable-pilot-release-gate.test.mjs` so the canonical command assertion tracks the new contract-spec set exactly.

### Tighten OpenAPI parity around view list/delete

Extend `scripts/ops/multitable-openapi-parity.test.mjs` with low-friction assertions for:

- `GET /api/multitable/views`
  - requires `sheetId`
  - returns `data.views[]` of `MultitableView`
- `DELETE /api/multitable/views/{viewId}`
  - returns `data.deleted` as `string`

These checks intentionally stay narrow so they lock the runtime contract without overfitting the generated OpenAPI layout.

## Files

- `scripts/ops/multitable-pilot-release-gate.sh`
- `scripts/ops/multitable-pilot-release-gate.test.mjs`
- `scripts/ops/multitable-openapi-parity.test.mjs`

## Outcome

The multitable pilot gate now treats the `ViewManager` CRUD/form bridge as release-critical contract surface, and the parity suite explicitly guards the corresponding view list/delete OpenAPI contracts.
