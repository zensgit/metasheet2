# PLM Workbench Local Preset Hydration Management Verification

## Scope

- `apps/web/src/views/plm/plmHydratedLocalFilterPresetTakeover.ts`
- `apps/web/src/views/PlmProductView.vue`
- `apps/web/tests/plmHydratedLocalFilterPresetTakeover.spec.ts`

## Checks

1. Route owner 从本地 preset A 切到 B 时，helper 会清空 selector、name/group drafts、batch selection、batch group draft。
2. Route owner 与当前 selector 相同，或 route 上没有显式 local owner 时，helper 保留这些本地管理态。
3. `PlmProductView.vue` 的 BOM / Where-Used hydration wiring 会把 helper 返回的 selection / batch-group cleanup 真正写回页面状态。

## Validation Commands

- `pnpm --filter @metasheet/web exec vitest run tests/plmHydratedLocalFilterPresetTakeover.spec.ts tests/plmWorkbenchViewState.spec.ts`
- `pnpm --filter @metasheet/web type-check`
- `cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`
