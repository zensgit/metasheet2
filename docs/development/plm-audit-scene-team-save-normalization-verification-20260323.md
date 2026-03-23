# PLM Audit Scene Team Save Normalization Verification

Date: 2026-03-23

## Scope

Verify that scene team-view saves now normalize back to canonical scene filters before persisting team/default audit views.

## Type Safety

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
```

Result:

- passed

## Focused Regression

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmAuditSceneContext.spec.ts
```

Result:

- `1` file passed
- `8` tests passed

Covered assertions:

- canonical scene saved-view state still normalizes owner/query scene routes correctly
- canonical scene team-view state normalizes drifted scene saves back to owner/query scene filters before persisting team/default views

## Full PLM Frontend Regression

Command:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Result:

- `43` files passed
- `264` tests passed
