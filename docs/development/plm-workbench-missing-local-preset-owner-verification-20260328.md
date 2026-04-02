# PLM Workbench Missing Local Preset Owner Verification

## Scope

- `apps/web/src/views/plm/plmLocalFilterPresetRouteIdentity.ts`
- `apps/web/src/views/PlmProductView.vue`
- `apps/web/tests/plmLocalFilterPresetRouteIdentity.spec.ts`

## Checks

1. route owner 失效且 selector 仍指向同一个缺失 preset 时，会清掉 route owner、selector、name/group 草稿、batch selection、batch group draft。
2. route owner 失效但用户已经切到另一个 pending selector 时，会只清失效 route owner，并把 batch selection 里的 stale key 裁掉，保留 pending selector 和它的草稿。
3. `applyQueryState()` 的 missing-route-owner 分支会直接消费 helper 结果，不再只 purge URL。

## Validation Commands

- `pnpm --filter @metasheet/web exec vitest run tests/plmLocalFilterPresetRouteIdentity.spec.ts tests/plmHydratedLocalFilterPresetTakeover.spec.ts`
- `pnpm --filter @metasheet/web type-check`
- `cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`
