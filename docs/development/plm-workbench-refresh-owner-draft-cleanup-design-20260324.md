# PLM Workbench Refresh Owner Draft Cleanup Design

Date: 2026-03-24

## Problem

[usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts) 之前已经会在 refresh、delete、archive、batch archive 清掉失效的 `teamViewKey` 和 `teamViewName`，但同一份 management 草稿里的 `teamViewOwnerUserId` 没有一起清理。

[PlmTeamViewsBlock.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/components/plm/PlmTeamViewsBlock.vue) 的 owner 输入框是长期挂在团队视图管理区里的：

- `v-model.trim="teamViewOwnerUserId.value"`

所以一旦当前选中的 team view 被 refresh 刷掉、变成不可 apply，或者被 delete/archive/batch archive 清空选中目标，旧的 owner draft 仍会直接残留在输入框里。

结果是：

- 用户已经不再选中任何可管理的 team view
- 但转移 owner 输入框里还保留上一条记录的用户 ID
- 页面出现典型的 stale management-draft residue

## Design

### 1. refresh deselect 时同步清 owner draft

`refreshTeamViews()` 在以下两条分支里，除了清 `teamViewKey` 和 `teamViewName`，现在也同步清 `teamViewOwnerUserId`：

- 当前选中的 team view 在 refresh 结果里已不存在
- 当前选中的 team view 仍存在，但 `canApplyPlmCollaborativeEntry(...) === false`

### 2. destructive deselect 与 refresh 合同保持一致

以下会显式清空当前 team view 选中目标的路径，也统一清理 `teamViewOwnerUserId`：

- `deleteTeamView()`
- `archiveTeamView()`
- `runBatchTeamViewAction()` 里命中当前选中项且不是 `restore` 的分支

这样 owner draft cleanup 和现有的 `teamViewName` cleanup 保持对称。

### 3. 不影响 create/save 草稿

这轮不把 owner draft 扩展成 create-mode 语义。

保留的合同是：

- `teamViewName` 可以在未选中 team view 时继续作为 `Save to team` 草稿
- `teamViewOwnerUserId` 仍只属于当前选中的管理目标

## Regression coverage

[usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts) 这轮锁住了 4 条 focused regression：

- stale non-applyable selection refresh 到默认视图时，owner draft 会被清空
- refresh 直接移除当前选中的 team view 时，owner draft 会被清空
- delete 当前 team view 时，owner draft 会被清空
- batch archive 命中当前选中项时，owner draft 会被清空

## Files

- [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts)
- [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts)
- [PlmTeamViewsBlock.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/components/plm/PlmTeamViewsBlock.vue)

## Non-goals

- 不改变 `transfer-owner` 权限 gating
- 不引入新的 owner-draft ownership 模型
- 不改变 `restore` 成功后重新选中 team view 的行为
