# PLM Workbench Local Preset Team Takeover Management Verification

## Scope

- `apps/web/src/views/plm/plmLocalPresetOwnership.ts`
- `apps/web/src/views/PlmProductView.vue`
- `apps/web/tests/plmLocalPresetOwnership.spec.ts`

## Checks

1. 本地 preset owner 成功被 team preset takeover 后，`clearLocalOwner` 会清空：
   - `selectedPresetKey`
   - `nameDraft`
   - `groupDraft`
   - `selectionKeys`
   - `batchGroupDraft`
2. BOM / Where-Used 共用同一份 cleared management helper，不再各自维护分叉语义。
3. helper 回归测试锁住“完整 management cleanup”合同，避免后续只清 key/query 又漏掉 batch state。

## Validation Commands

- `pnpm --filter @metasheet/web exec vitest run tests/plmFilterPresetUtils.spec.ts tests/plmLocalFilterPresetRouteIdentity.spec.ts tests/plmLocalPresetOwnership.spec.ts`
- `pnpm --filter @metasheet/web type-check`
- `cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`
