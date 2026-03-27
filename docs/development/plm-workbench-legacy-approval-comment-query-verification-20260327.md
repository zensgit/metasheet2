# PLM Workbench Legacy Approval Comment Query Verification

## Scope

- `apps/web/src/views/plm/plmWorkbenchViewState.ts`
- `apps/web/tests/plmWorkbenchViewState.spec.ts`

## Checks

1. `normalizePlmWorkbenchQuerySnapshot(...)` 不再把 `approvalComment` 纳入 canonical snapshot。
2. `buildPlmWorkbenchLegacyLocalDraftQueryPatch(...)` 对旧 URL 中的 `approvalComment` 仍会返回清理 patch。
3. array 形式的 legacy query 值同样会被识别并清理。

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmWorkbenchViewState.spec.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Result

- focused state tests:
  - `pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchViewState.spec.ts`
  - `1` file / `28` tests passed
- web type-check:
  - `pnpm --filter @metasheet/web type-check`
  - passed
- frontend full suite:
  - `cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`
  - `60` files / `464` tests passed
