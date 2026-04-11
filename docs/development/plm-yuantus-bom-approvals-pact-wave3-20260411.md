# PLM Yuantus BOM And Approval Pact Wave 3

## Scope

This slice extends the hand-authored Metasheet2 -> Yuantus pact from 9 to 14
interactions by covering the next five **real** `PLMAdapter.ts` call sites on
`main`:

- `GET /api/v1/bom/{id}/where-used`
- `GET /api/v1/bom/compare/schema`
- `GET /api/v1/eco/{id}/approvals`
- `POST /api/v1/eco/{id}/approve`
- `POST /api/v1/eco/{id}/reject`

Source call sites on `main`:

- `packages/core-backend/src/data-adapters/PLMAdapter.ts:1636`
- `packages/core-backend/src/data-adapters/PLMAdapter.ts:1662`
- `packages/core-backend/src/data-adapters/PLMAdapter.ts:1683`
- `packages/core-backend/src/data-adapters/PLMAdapter.ts:1715`
- `packages/core-backend/src/data-adapters/PLMAdapter.ts:1813`

## Design Decisions

1. Keep contract-first discipline strict.
Only endpoints with live consumer call sites were added. `aml/metadata` stays
out because `PLMAdapter.ts` still does not call it.

2. Append, do not reorder, prior interactions.
The 9 previously verified interactions remain byte-stable and the 5 new ones
append at the tail of the pact. This minimizes diff noise and keeps provider
history legible.

3. Lock payload shape where the adapter has real semantics.
The Wave 3 pact now freezes:

- `recursive` / `max_levels` on where-used
- compare schema array/object envelopes
- approval history list shape
- optimistic-lock action payload shape for `approve` / `reject`

4. Back the pact with adapter unit coverage.
`plm-adapter-yuantus.test.ts` now asserts the adapter calls the exact Wave 3
paths and payloads, so a future source change can fail before pact drift reaches
CI.

## Files Changed

- `packages/core-backend/tests/contract/pacts/metasheet2-yuantus-plm.json`
- `packages/core-backend/tests/contract/plm-adapter-yuantus.pact.test.ts`
- `packages/core-backend/tests/contract/README.md`
- `packages/core-backend/tests/unit/plm-adapter-yuantus.test.ts`

## Verification

Run from `packages/core-backend`:

```bash
npx vitest run tests/contract/plm-adapter-yuantus.pact.test.ts
npx vitest run tests/unit/plm-adapter-yuantus.test.ts
npx vitest run tests/unit/federation.contract.test.ts
npx vitest run tests/unit/approvals-bridge-routes.test.ts
```

Observed results on 2026-04-11:

- `tests/contract/plm-adapter-yuantus.pact.test.ts`: 10 passed
- `tests/unit/plm-adapter-yuantus.test.ts`: 14 passed
- `tests/unit/federation.contract.test.ts`: 10 passed
- `tests/unit/approvals-bridge-routes.test.ts`: 20 passed

## Notes

The clean worktree needs both dependency trees linked:

- repo root `node_modules`
- `packages/core-backend/node_modules`

Without the package-local symlink, Vitest fails before collection on unresolved
pnpm-linked dependencies such as `uuid`.
