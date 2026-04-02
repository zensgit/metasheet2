# PLM Workbench Local Preset Catalog Management Cleanup Verification

## Scope

- `apps/web/src/views/plm/plmFilterPresetUtils.ts`
- `apps/web/src/views/PlmProductView.vue`
- `apps/web/tests/plmFilterPresetUtils.spec.ts`

## Checks

1. `resolveFilterPresetCatalogDraftState(...)` 会过滤掉失效的 `selectionKeys`。
2. 当没有 surviving selection 时，`batchGroupDraft` 会被清空。
3. `single delete / batch delete / import / clear` 都会消费 helper 输出，把 `selection + batchGroupDraft` 真正写回页面状态。
4. stale local route-owner 被 reconcile 掉时，页面上的 batch management state 也会一起对齐，不再保留旧 preset 的批量残留。

## Validation Commands

- `pnpm --filter @metasheet/web exec vitest run tests/plmFilterPresetUtils.spec.ts tests/plmLocalFilterPresetRouteIdentity.spec.ts`
- `pnpm --filter @metasheet/web type-check`
- `cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`
