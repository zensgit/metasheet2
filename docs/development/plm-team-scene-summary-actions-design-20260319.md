# PLM Team Scene Summary Actions Design

## Goal

把“团队场景目录”的摘要 chip 从被动筛选器升级成真正的快捷动作：

- 点击 chip 后立即切换推荐筛选
- 自动滚动到首条推荐卡片
- 对首条推荐卡片做短暂高亮

这样用户不需要再手动从头扫列表。

## Design

### Component-local interaction

这层行为直接放在 [PlmProductPanel.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/components/plm/PlmProductPanel.vue)，而不是放回页面级：

- `handleSceneCatalogSummaryClick(...)`
- `setSceneCatalogItemRef(...)`
- `highlightScene(...)`
- `clearSceneCatalogHighlight(...)`

原因：

- 行为只跟目录组件自身的 DOM 结构有关
- 不需要把滚动和高亮状态上抬到页面壳
- 保持 `PlmProductView` 继续只做状态编排

### Interaction flow

点击摘要 chip 时：

1. 调 `panel.setSceneCatalogRecommendationFilter(...)`
2. `await nextTick()` 等待列表刷新
3. 取当前 `recommendedWorkbenchScenes` 的首条
4. 自动 `scrollIntoView`
5. 短暂加上 `scene-catalog__item--highlighted`
6. 定时清除高亮

### Accessibility

- summary chip 加 `aria-pressed`
- 场景卡片加 `tabindex="-1"`，滚动后同时 focus

### Styling

在 [PlmPanelShared.css](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/components/plm/PlmPanelShared.css) 中增加：

- `.scene-catalog__item--highlighted`

用浅蓝背景、边框和外圈阴影表达“推荐入口已定位”。

## Why this is better

- 不只是切筛选，而是直接把用户带到下一步动作
- 不引入新的页面状态模型，复杂度停留在组件层
- 和上一轮的摘要 chip / 推荐理由说明自然衔接
