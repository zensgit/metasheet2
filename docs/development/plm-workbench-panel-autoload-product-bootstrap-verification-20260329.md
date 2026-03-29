# PLM Workbench Panel Autoload Product Bootstrap Verification

## Focused Verification

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmWorkbenchViewState.spec.ts
```

Expected:

- `shouldAutoloadPlmProductContext(...)` returns `true` for document/approval panel routes with only `itemNumber`
- it returns `false` for non-product-scoped panel routes such as `cad`
- existing share-link expectations remain green

## Safety Verification

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
```

Expected:

- `PlmProductView` compiles with the new bootstrap helper wiring

## Regression Verification

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Expected:

- frontend PLM regression suite remains green after the autoload bootstrap change
