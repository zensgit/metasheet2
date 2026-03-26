# Multitable View Manager Contract Alignment Verification

Date: 2026-03-26  
Branch: `codex/multitable-next`

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/view-manager-multitable-contract.spec.ts --watch=false
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-view-config.api.test.ts --reporter=dot
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
```

## Expected Results

- `ViewManager` create/update/delete/list CRUD hits `/api/multitable/views` contracts rather than legacy `/api/views`
- service response parsing matches runtime `ok/data.*`
- backend delete-view route returns the expected `200` and `404` payloads
- frontend type-check and build still pass

## Notes

- This slice does not modify the existing dirty multitable UI files in the worktree.
- Verification is intentionally split into one frontend service spec and one backend integration file so the contract drift is isolated and easy to bisect.
