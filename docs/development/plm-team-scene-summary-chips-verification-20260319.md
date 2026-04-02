# PLM Team Scene Summary Chips Verification

## Scope

验证“团队场景目录摘要 chip + 一键切换筛选”这一层是否闭环。

## Files

- [plmWorkbenchSceneCatalog.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmWorkbenchSceneCatalog.ts)
- [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmProductView.vue)
- [usePlmProductPanel.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmProductPanel.ts)
- [PlmProductPanel.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/components/plm/PlmProductPanel.vue)
- [PlmPanelShared.css](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/components/plm/PlmPanelShared.css)
- [plmWorkbenchSceneCatalog.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmWorkbenchSceneCatalog.spec.ts)
- [usePlmProductPanel.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmProductPanel.spec.ts)

## Commands

```bash
TMPDIR=/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/.tmp pnpm --filter @metasheet/web exec vitest run --watch=false tests/plmWorkbenchSceneCatalog.spec.ts tests/usePlmProductPanel.spec.ts
pnpm --filter @metasheet/web test
pnpm --filter @metasheet/web type-check
pnpm --filter @metasheet/web lint
pnpm --filter @metasheet/web build
```

## Expected

- 摘要 chip 计数基于 `owner` 过滤和推荐理由
- active chip 与当前推荐筛选一致
- 当前推荐理由说明与 active chip 一致
- `PlmProductPanel` contract 暴露摘要 chip 和 setter
- 页面、类型、lint、构建全部通过

## Notes

这轮没有重跑真实 `PLM UI regression`，因为改动只在前端目录展示和筛选层，没有碰联邦接口、SDK 契约或上游 `Yuantus` 行为。

## Result

- focused frontend:
  - `tests/plmWorkbenchSceneCatalog.spec.ts`
  - `tests/usePlmProductPanel.spec.ts`
  - `2 files / 10 tests` 通过
- `pnpm --filter @metasheet/web test` 通过，`34 files / 182 tests`
- `pnpm --filter @metasheet/web type-check` 通过
- `pnpm --filter @metasheet/web lint` 通过
- `pnpm --filter @metasheet/web build` 通过
