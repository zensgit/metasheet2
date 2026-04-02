# PLM Workbench Panel Share Product Context Verification

## Focused Verification

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmWorkbenchViewState.spec.ts
```

Expected:

- document team-view share URLs include `productId` and `autoload=true` when product context is supplied
- approval team-view share URLs include `itemNumber`, non-default `itemType`, and `autoload=true` when only item identity is supplied
- existing context-free panel share URL expectations remain unchanged

## Safety Verification

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
```

Expected:

- `PlmProductView` call sites compile with the new optional share-route context argument

## Regression Verification

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Expected:

- PLM frontend regression suite remains green after the share-link transport change
