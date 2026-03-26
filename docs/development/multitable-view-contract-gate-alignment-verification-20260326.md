# Multitable View Contract Gate Alignment Verification

Date: 2026-03-26  
Branch: `codex/multitable-next`

## Commands

```bash
pnpm verify:multitable-pilot:release-gate:test
pnpm verify:multitable-openapi:parity
pnpm --filter @metasheet/web exec vitest run tests/multitable-embed-route.spec.ts tests/multitable-client.spec.ts tests/view-manager-multitable-contract.spec.ts --watch=false
```

## Expected Results

- the canonical release-gate test expects `view-manager-multitable-contract.spec.ts` inside `web.vitest.multitable.contracts`
- OpenAPI parity explicitly guards multitable view list and delete contracts
- the focused frontend contract suite stays green after the gate/parity tightening

## Notes

- This slice only tightens gate coverage and parity checks.
- It does not touch the existing multitable UI WIP files in the worktree.
