# PLM Workbench Scene Copy-Link Share Gating Design

Date: 2026-03-24

## Problem

`workbench scene` 推荐卡的默认 secondary action 是 `copy-link`，但这条链路之前没有对齐 `canShare`。

具体有三层缺口：

- [plmWorkbenchSceneCatalog.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmWorkbenchSceneCatalog.ts) 会无条件给默认场景产出 `copy-link`
- [PlmProductPanel.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/components/plm/PlmProductPanel.vue) 会把 secondary button 直接渲染成可点
- [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmProductView.vue) 的 `copyRecommendedWorkbenchSceneLink(...)` 直接复制分享 URL，不校验 `canShare`

这意味着 generic workbench team-view 管理区能正确锁住 `Share`，但推荐场景卡还能继续复制同一条分享链接。

这轮我同样用了已登录的 `Claude Code` 做并行只读校验，它确认了这条镜像 `canShare` bypass。

## Design

### 1. 给 scene recommendation model 加 secondary disabled contract

[plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmPanelModels.ts) 的 `PlmRecommendedWorkbenchScene` 现在新增：

- `secondaryActionDisabled`

这样 workbench scene recommendation 和 audit recommendation 的模型契约保持一致。

### 2. catalog builder 直接对齐 `canShare`

[plmWorkbenchSceneCatalog.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmWorkbenchSceneCatalog.ts) 现在复用 `canSharePlmCollaborativeEntry(...)`。

规则是：

- 默认场景的 `copy-link` 仍然保留
- 但如果底层 team view 不允许分享，则 recommendation 直接把 secondary action 标为 disabled
- `open-audit` 路径不受影响

### 3. 页面再补一层 defensive gate

[PlmProductPanel.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/components/plm/PlmProductPanel.vue) 现在读取 `scene.secondaryActionDisabled`。

[PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmProductView.vue) 的 `copyRecommendedWorkbenchSceneLink(...)` 也新增了 `canSharePlmCollaborativeEntry(...)` 守卫，避免未来有别的入口绕过面板按钮。

## Files

- [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmPanelModels.ts)
- [plmWorkbenchSceneCatalog.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmWorkbenchSceneCatalog.ts)
- [PlmProductPanel.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/components/plm/PlmProductPanel.vue)
- [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmProductView.vue)
- [plmWorkbenchSceneCatalog.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmWorkbenchSceneCatalog.spec.ts)
- [usePlmProductPanel.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmProductPanel.spec.ts)

## Non-goals

- 不改变 `open-audit` secondary action 语义
- 不改变 scene recommendation 的排序和 filter bucket
- 不扩到其他 panel 的 share CTA；这轮只收 `workbench scene` 推荐卡
