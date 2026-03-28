# PLM Workbench Local Preset Route Parity Verification

## Scope

- `apps/web/src/views/plm/plmHydratedLocalFilterPresetTakeover.ts`
- `apps/web/src/views/PlmProductView.vue`
- `apps/web/src/views/plm/plmWorkbenchViewState.ts`
- `apps/web/tests/plmHydratedLocalFilterPresetTakeover.spec.ts`
- `apps/web/tests/plmWorkbenchViewState.spec.ts`

## Checks

1. external local preset hydration 会在 route owner takeover 时：
   - 清掉无 selector 的 stale batch 管理态
   - 裁掉和 route owner 不一致的 selection key
   - 仅在仍有 surviving selection 时保留 batch group
2. same-key import reconcile 会同步写回 `nextNameDraft/nextGroupDraft`，不再只改 selector/query。
3. 默认 team preset auto-apply 遇到缺失的本地 preset query 时：
   - 不再把它当作有效 blocker
   - 但真正存在的 local preset owner 仍继续阻断默认接管

## Validation Commands

- `pnpm --filter @metasheet/web exec vitest run tests/plmHydratedLocalFilterPresetTakeover.spec.ts tests/plmWorkbenchViewState.spec.ts`
- `pnpm --filter @metasheet/web type-check`
- `cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`
