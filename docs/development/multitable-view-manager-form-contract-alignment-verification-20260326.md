# Multitable View Manager Form Contract Alignment Verification

Date: 2026-03-26  
Branch: `codex/multitable-next`

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/view-manager-multitable-contract.spec.ts --watch=false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
```

## Expected Results

- `createGalleryView()` hits `POST /api/multitable/views`
- `createFormView()` hits `POST /api/multitable/views`
- `submitForm()` hits `POST /api/multitable/views/:viewId/submit`
- runtime success is normalized back into the legacy `FormSubmissionResponse` shape expected by `FormView.vue`
- type-check and build stay green

## Notes

- This slice intentionally leaves `loadViewConfig`, `saveViewConfig`, `loadViewData`, `loadViewState`, `saveViewState`, and `getFormResponses` untouched because they do not currently have a clean one-to-one runtime replacement in this worktree.
