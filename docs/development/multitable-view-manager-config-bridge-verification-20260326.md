# Multitable View Manager Config Bridge Verification

Date: 2026-03-26  
Branch: `codex/multitable-next`

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/view-manager-multitable-contract.spec.ts --watch=false
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-context.api.test.ts --reporter=dot
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
```

## Expected Results

- `loadViewConfig()` reads config through `/api/multitable/context?viewId=...`
- `saveViewConfig()` writes config through `PATCH /api/multitable/views/:viewId`
- gallery/form/calendar runtime config is restored into the legacy top-level shape expected by the existing view components
- `context?viewId=` still resolves the target sheet/view config on the backend
- the service contract spec, type-check, and build remain green

## Notes

- This slice only changes the shared `ViewManager` service and its focused contract spec.
- Existing multitable UI WIP files in the worktree remain untouched.
