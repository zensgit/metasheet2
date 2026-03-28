# Multitable View Manager Client Delegation Verification

Date: 2026-03-26  
Branch: `codex/multitable-next`

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/view-manager-multitable-contract.spec.ts --watch=false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
```

## Expected Results

- `ViewManager` still uses the same multitable runtime endpoints for create/update/delete/list/create-gallery/create-form/submit
- contract spec remains green after the transport refactor
- type-check and build remain green

## Notes

- This is a quality-improvement slice, not a new feature slice.
- Legacy-only `ViewManager` methods remain intentionally untouched in this step.
