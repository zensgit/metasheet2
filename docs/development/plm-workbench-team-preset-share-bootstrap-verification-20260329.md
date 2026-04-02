# PLM Workbench Team Preset Share Bootstrap Verification

## Scope

Validate that `BOM / Where-Used team preset` share links preserve enough route context
for cold-start bootstrap.

## Files

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmFilterPresetUtils.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmProductView.vue`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmFilterPresetUtils.spec.ts`

## Added Assertions

Focused coverage now verifies:

- `BOM` team preset share links include:
  - `productId`
  - `itemNumber`
  - `itemType`
  - `autoload=true`
- `Where-Used` team preset share links include:
  - `productId`
  - `itemNumber`
  - `itemType`
  - `whereUsedItemId`
  - `autoload=true`

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/plmFilterPresetUtils.spec.ts
pnpm --filter @metasheet/web type-check
cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Results

- focused `plmFilterPresetUtils.spec.ts`: passed
- `pnpm --filter @metasheet/web type-check`: passed
- full frontend `plm*.spec.ts` + `usePlm*.spec.ts`: passed

## Conclusion

`team preset share` links now match the cold-start expectations already established for
other PLM share flows, and no longer stop at route hydration without panel bootstrap.
