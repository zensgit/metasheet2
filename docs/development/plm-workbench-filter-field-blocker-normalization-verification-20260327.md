# PLM Workbench Filter Field Blocker Normalization Verification

## Scope

- `apps/web/src/views/plm/plmWorkbenchViewState.ts`
- `apps/web/tests/plmWorkbenchViewState.spec.ts`

## Checks

1. `bomFilterField=path` 且没有 `bomFilter` 时，不再阻断默认 BOM team preset。
2. `whereUsedFilterField=parent` 且没有 `whereUsedFilter` 时，不再阻断默认 Where-Used team preset。
3. 非空 `filter` + 非默认 `filterField` 仍然继续阻断默认 takeover。

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

- focused workbench state tests:
  - `pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchViewState.spec.ts`
  - `1` file / `28` tests passed
- web type-check:
  - `pnpm --filter @metasheet/web type-check`
  - passed
- frontend full suite:
  - `cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`
  - `60` files / `464` tests passed
