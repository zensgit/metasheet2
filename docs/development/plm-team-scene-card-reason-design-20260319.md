# PLM Team Scene Card Reason Design

## Goal

让“团队场景目录”的每张推荐卡片不只显示 badge，而是明确说明推荐来源。

当前推荐来源分为三类：

- 当前团队默认场景
- 近期被设为团队默认场景
- 近期更新的团队场景

## Design

### Scene helper

在 [plmWorkbenchSceneCatalog.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmWorkbenchSceneCatalog.ts) 中补 `getRecommendationSource(...)`，并在 `buildRecommendedWorkbenchScenes(...)` 返回：

- `recommendationSourceLabel`
- `recommendationSourceTimestamp`

这样推荐来源的语义和时间源都在 helper 层固定，不让组件自己猜。

### Scene model

在 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmPanelModels.ts) 的 `PlmRecommendedWorkbenchScene` 中补：

- `recommendationSourceLabel`
- `recommendationSourceTimestamp`

### UI

在 [PlmProductPanel.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/components/plm/PlmProductPanel.vue) 每张推荐卡片下方新增：

- `推荐来源：{{ recommendationSourceLabel }}`
- 有时间时追加格式化时间

样式放在 [PlmPanelShared.css](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/components/plm/PlmPanelShared.css) 的 `.scene-catalog__reason`。

## Why this is better

- 比单个 badge 更明确，用户能直接理解“为什么推荐”
- 推荐语义继续由 helper 统一，不把规则散落到模板里
- 和摘要 chip / 推荐理由说明形成上下呼应
