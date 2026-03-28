# Multitable Submit Contract Alignment Verification

Date: 2026-03-26  
Branch: `codex/multitable-next`

## Commands

```bash
pnpm verify:multitable-pilot:readiness:test
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-context.api.test.ts tests/integration/multitable-record-form.api.test.ts --reporter=dot
node --check scripts/verify-multitable-live-smoke.mjs
```

## Expected Results

- readiness tests pass with the renamed required smoke check `api.multitable.view-submit`
- multitable context integration passes with delete-sheet success and not-found coverage
- multitable record/form integration passes with direct patch not-found coverage
- live smoke script parses and resolves the runtime submit route `/api/multitable/views/:viewId/submit`

## Notes

- This slice does not touch the in-progress multitable UI worktree files (`MetaFieldManager`, `MetaFormView`, `MetaImportModal`, `MetaViewManager`, `MultitableEmbedHost`, `MultitableWorkbench`).
- Verification is intentionally limited to clean script and backend contract surfaces so it can ship independently of the UI WIP.
