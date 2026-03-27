# PLM Workbench Runtime Filter Field Blocker Alignment Verification

## Scope

- `apps/web/src/views/PlmProductView.vue`
- `apps/web/tests/plmWorkbenchViewState.spec.ts`

## Checks

1. `BOM` field-only no-op 状态不再阻断默认 team preset。
2. `Where-Used` field-only no-op 状态不再阻断默认 team preset。
3. helper 和页面运行时条件重新对齐。

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchViewState.spec.ts
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
