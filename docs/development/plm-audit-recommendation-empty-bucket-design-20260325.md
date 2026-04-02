# PLM Audit Recommendation Empty Bucket Design

## 背景

`PlmAuditView.vue` 的推荐审计团队视图区之前直接用：

- `recommendedAuditTeamViews.length`

决定整块是否渲染。

但推荐 filter chip 是独立存在的，且 [buildAuditTeamViewSummaryChips()](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditTeamViewCatalog.ts) 会稳定产出 `count = 0` 的 bucket。

## 问题

当用户点到一个 `0` 结果 bucket 时：

1. `recommendedAuditTeamViews` 变成空数组
2. 整个推荐区直接消失
3. chip 自己也一起消失

结果是用户失去“切回全部推荐”的恢复入口，只能靠刷新或其它状态变化把推荐区找回来。

## 设计

把“推荐区是否显示”和“当前 bucket 是否有卡片”分开：

1. 在 [plmAuditTeamViewCatalog.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditTeamViewCatalog.ts) 新增 `shouldShowAuditTeamViewRecommendations(chips)`
   - 只要任一 chip `count > 0`，推荐区就继续显示
   - 也就是只要系统里还有任何可推荐审计团队视图，就不隐藏 header / chips

2. `PlmAuditView.vue` 改成：
   - 用 `showAuditTeamViewRecommendations` 控整块显示
   - 当 `recommendedAuditTeamViews.length === 0` 时，不再隐藏整块
   - 只在卡片区域显示空态文案

3. 空态文案按当前 active chip 定制
   - 默认 bucket：`当前暂无可推荐的审计团队视图。`
   - 非默认 bucket：提示切回 `全部推荐`

## 结果

- 进入 `0` 结果 bucket 后，推荐 header 和 chips 仍然可见
- 用户仍能直接点击 `全部推荐` 或其它 bucket 恢复列表
- 推荐区的存在与否只取决于“是否还有任何可推荐审计团队视图”，不再取决于当前筛选结果是否为空
