# PLM Workbench Local Preset Route Removal Verification

## Scope

- `apps/web/src/views/PlmProductView.vue`
- `apps/web/src/views/plm/plmLocalFilterPresetRouteIdentity.ts`
- `apps/web/tests/plmLocalFilterPresetRouteIdentity.spec.ts`

## Checks

1. 当 route query 删除 `bomFilterPreset / whereUsedFilterPreset` 时，页面不会再保留旧的 in-memory route owner。
2. 旧 route owner 被删除后，本轮 `applyQueryState()` 不会再重放旧 preset。
3. 现有 missing-owner cleanup 合同继续成立：
   - 若 selector 仍指向旧 owner，则清空 selector / drafts / selection / batchGroup
   - 若用户已经切到另一个 pending selector，则只清旧 owner，并保留 pending 管理态

## Validation Commands

- `pnpm --filter @metasheet/web exec vitest run tests/plmLocalFilterPresetRouteIdentity.spec.ts tests/plmWorkbenchViewState.spec.ts`
- `pnpm --filter @metasheet/web type-check`
- `cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`
