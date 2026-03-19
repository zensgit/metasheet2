# PLM Team Scene Card Actions Design

## Goal

让推荐场景卡片根据推荐来源显示不同的主动作，而不再统一显示“应用 / 复制链接”。

## Design

在 [plmWorkbenchSceneCatalog.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmWorkbenchSceneCatalog.ts) 中新增 `getRecommendationActions(...)`，并让 `buildRecommendedWorkbenchScenes(...)` 返回：

- `primaryActionLabel`
- `secondaryActionLabel`

当前规则：

- `default`: `进入默认场景` / `复制默认链接`
- `recent-default`: `查看近期默认` / `复制近期默认链接`
- `recent-update`: `查看最新更新` / `复制更新场景链接`

这样动作语义继续由 helper 固化，组件只负责渲染。

在 [PlmProductPanel.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/components/plm/PlmProductPanel.vue) 中，卡片按钮直接消费这组动作文案。

## Why this is better

- 卡片动作更符合推荐来源，不再所有卡片都像同一种入口
- 语义集中在 helper 层，避免模板内散落条件判断
- 和上一轮的“推荐来源说明”形成配套
