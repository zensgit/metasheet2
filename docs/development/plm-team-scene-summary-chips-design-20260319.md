# PLM Team Scene Summary Chips Design

## Goal

在产品页的“团队场景目录”上方补一层摘要 chip，让用户可以直接看到推荐分布，并一键切换到：

- 全部推荐
- 当前默认
- 近期默认
- 近期更新

同时在 chip 下方补一条当前推荐理由说明，避免用户只能看到标签和数量。

## Design

### Shared helper

在 [plmWorkbenchSceneCatalog.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmWorkbenchSceneCatalog.ts) 中新增：

- `buildWorkbenchSceneSummaryChips(...)`
- `buildWorkbenchSceneSummaryHint(...)`

它与现有的 `buildRecommendedWorkbenchScenes(...)` 共享同一套推荐理由判定：

- `default`
- `recent-default`
- `recent-update`

摘要统计遵循和目录相同的前置过滤：

- 先排除已归档团队场景
- 再应用 owner 过滤
- 最后只把 `recommendationFilter` 用于决定 active chip，而不是影响计数基线

`buildWorkbenchSceneSummaryHint(...)` 基于当前 active chip 输出一条用户可读的推荐理由说明。

### Panel contract

在 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmPanelModels.ts) 的 `PlmProductPanelModel` 中补：

- `sceneCatalogSummaryChips`
- `sceneCatalogSummaryHint`
- `setSceneCatalogRecommendationFilter`

这样 `PlmProductPanel` 不需要理解推荐规则或页面状态，只消费已经装好的 summary chip 数据和点击动作。

### View wiring

在 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmProductView.vue)：

- 基于 `workbenchTeamViews + owner filter + recommendation filter` 计算 `sceneCatalogSummaryChips`
- 基于 active chip 计算 `sceneCatalogSummaryHint`
- 暴露 `setSceneCatalogRecommendationFilter(...)`
- 继续把 `recommendedWorkbenchScenes` 作为目录内容源

### UI

在 [PlmProductPanel.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/components/plm/PlmProductPanel.vue)：

- 在目录 header 与列表之间插入 summary chip 行
- chip 使用按钮语义，点击后立即切换推荐筛选
- active chip 用独立样式强调
- 在 chip 下方显示当前推荐理由说明

样式在 [PlmPanelShared.css](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/components/plm/PlmPanelShared.css)。

## Why this is better

- 比只靠下拉筛选更快，能先看分布，再筛选
- 沿用现有推荐理由，不引入第二套“摘要规则”
- 继续保持 `PlmProductView` 只做状态编排，推荐统计逻辑留在 helper 层
