# PLM Workbench Scene Applyability Gating Design

Date: 2026-03-24

## Problem

`workbench scene` 推荐卡 primary action 之前没有对齐 `canApply` 合同。

具体缺口有四层：

- [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmPanelModels.ts) 的 `PlmRecommendedWorkbenchScene` 没有 `primaryActionDisabled`
- [plmWorkbenchSceneCatalog.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmWorkbenchSceneCatalog.ts) 不会根据 `permissions.canApply` 计算推荐卡主操作可执行性
- [PlmProductPanel.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/components/plm/PlmProductPanel.vue) 的 primary button 没有 `:disabled`
- [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts) 的 `applyTeamView()` 只拦 `isArchived`，不拦 `permissions.canApply === false`

这意味着 generic selector 区块虽然有 `canApplyWorkbenchTeamView`，但 recommendation path 仍然可能把一个不可应用的 team view 设成当前目标并继续 apply。

这轮我同样用了已登录的 `Claude Code` 做并行只读校验，它也明确确认了这条 `canApply` bypass。

## Design

### 1. 抽出共享 `canApply` helper

[usePlmCollaborativePermissions.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmCollaborativePermissions.ts) 现在导出：

- `canApplyPlmCollaborativeEntry(...)`

这样 `canApply` 的定义不再只存在于 composable 内部，而是可以被：

- recommendation catalog builder
- page-level recommendation handler
- `usePlmTeamViews.applyTeamView()`

统一复用。

### 2. 给 workbench scene recommendation model 加 primary disabled contract

[plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmPanelModels.ts) 的 `PlmRecommendedWorkbenchScene` 现在新增：

- `primaryActionDisabled`

[plmWorkbenchSceneCatalog.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmWorkbenchSceneCatalog.ts) 会直接按 `!canApplyPlmCollaborativeEntry(view)` 产出它。

这样 `workbench scene` recommendation 和 `audit recommendation` 的主操作契约保持一致。

### 3. UI 和 handler 双层收口

[PlmProductPanel.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/components/plm/PlmProductPanel.vue) 现在会消费 `scene.primaryActionDisabled`。

[PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmProductView.vue) 的 `applyRecommendedWorkbenchScene(...)` 也新增了 `canApplyPlmCollaborativeEntry(...)` 守卫。

### 4. 底层 `applyTeamView()` 也补 defensive gate

[usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts) 的 `applyTeamView()` 不再只看 archived，而是统一按 `canApplyPlmCollaborativeEntry(...)` 拦截。

这一步很关键，因为它把 recommendation path 和 selector path 的最终 apply 语义彻底统一了。

## Files

- [usePlmCollaborativePermissions.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmCollaborativePermissions.ts)
- [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts)
- [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmPanelModels.ts)
- [plmWorkbenchSceneCatalog.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmWorkbenchSceneCatalog.ts)
- [PlmProductPanel.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/components/plm/PlmProductPanel.vue)
- [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmProductView.vue)
- [usePlmCollaborativePermissions.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmCollaborativePermissions.spec.ts)
- [plmWorkbenchSceneCatalog.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmWorkbenchSceneCatalog.spec.ts)
- [usePlmProductPanel.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmProductPanel.spec.ts)
- [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts)

## Non-goals

- 不改变 recommendation 排序或 filter bucket
- 不改变 secondary action 语义
- 不修改后端权限模型
