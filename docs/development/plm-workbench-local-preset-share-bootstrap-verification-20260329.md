# PLM Workbench Local Preset Share Bootstrap Verification

## Scope

Validate that local `BOM / Where-Used filter preset` share links preserve both import
payload and cold-start runtime context.

## Files

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmFilterPresetUtils.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmProductView.vue`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmFilterPresetUtils.spec.ts`

## Added Assertions

Focused coverage now verifies:

- `BOM` local preset share links include:
  - `panel=product`
  - `productId`
  - `itemNumber`
  - `itemType`
  - `autoload=true`
  - intact encoded `bomPresetShare` payload
- `Where-Used` local preset share links include:
  - `panel=where-used`
  - `productId`
  - `itemNumber`
  - `itemType`
  - `whereUsedItemId`
  - `autoload=true`
  - intact encoded `whereUsedPresetShare` payload

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

Local preset sharing no longer stops at payload transport only; it now lands with the
same cold-start context guarantees already enforced for team preset sharing.
