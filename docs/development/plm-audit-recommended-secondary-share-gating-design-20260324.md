# PLM Audit Recommended Secondary Share Gating Design

Date: 2026-03-24

## Problem

推荐团队视图卡片的 secondary action 之前只围绕 `canSetDefault` 建模，没有把 `canShare` 收进 recommendation contract。

结果会留下两层不一致：

- recommendation builder 只会在 `canSetDefault === false` 时回退到 `copy-link`，但不会继续检查这个视图是否真的允许分享
- 页面 handler 在 `copy-link` 分支里会直接走 `shareAuditTeamViewEntry(...)`，没有再经过 `canShare` gate

这意味着：

- generic 管理区的 `Share` 会正确受 `canShare` 约束
- 推荐卡却仍可能显示并执行 `复制视图链接`

这轮我同时用了已登录的 `Claude Code` 做并行只读校验，它也明确确认了这条 contract bug。

## Design

### 1. 把 secondary actionability 收进 recommendation model

[plmAuditTeamViewCatalog.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditTeamViewCatalog.ts) 现在新增：

- `secondaryActionDisabled`

它和现有的 `primaryActionDisabled` 形成对称：

- primary 负责 `canApply`
- secondary 负责 `copy-link / set-default` 的真实可执行性

### 2. `copy-link` 显式对齐 `canShare`

builder 现在复用 [usePlmCollaborativePermissions.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmCollaborativePermissions.ts) 里的 `canSharePlmCollaborativeEntry(...)`。

规则是：

- `set-default` 分支继续由 `canSetDefault` 决定是否出现
- fallback 到 `copy-link` 时，如果目标视图不允许分享，则 secondary action 直接标为 disabled
- `default` 推荐卡默认的 `copy-link` 也同样受 `canShare` 约束

### 3. 页面 handler 补 defensive share gate

[PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue) 里：

- 推荐卡 secondary 按钮现在读取 `view.secondaryActionDisabled`
- `runRecommendedAuditTeamViewSecondaryAction(...)` 在 `set-default` 分支显式校验 `canSetDefaultPlmCollaborativeEntry(target)`
- `copy-link` 分支显式校验 `canSharePlmCollaborativeEntry(target)`

这样 recommendation surface 和 generic management surface 的分享合同就一致了。

## Files

- [PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue)
- [plmAuditTeamViewCatalog.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditTeamViewCatalog.ts)
- [plmAuditTeamViewCatalog.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmAuditTeamViewCatalog.spec.ts)
- [usePlmCollaborativePermissions.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmCollaborativePermissions.ts)

## Non-goals

- 不改变推荐排序或 recommendation bucket
- 不改变 `set-default` 的推荐文案语义
- 不处理 workbench scene recommendation 上的镜像 `copy-link` 问题；那是下一条并行候选
