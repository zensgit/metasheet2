# PLM Workbench Refresh Batch Selection Actionability Design

Date: 2026-03-24

## Problem

[PlmTeamViewsBlock.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/components/plm/PlmTeamViewsBlock.vue) 的 batch checkbox 已经按当前 manageability 禁用：

- `:disabled="!(view.permissions?.canManage ?? view.canManage)"`

但 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts) 的 `refreshTeamViews()` 之前只按 `id` 是否还存在来保留 `teamViewSelection`。

结果是：

- 某条 team view refresh 后虽然变成只读
- checkbox 已经不能再改
- 但旧 selection 还留着
- UI 继续显示 `已选 1/N`

这是一条典型的 stale batch-selection residue。

## Design

### 1. refresh 同步 trim batch selection

`refreshTeamViews()` 现在不只看 `id` 是否仍存在，还会继续检查：

- `view.permissions?.canManage ?? view.canManage`

如果 refresh 后这条 team view 已经不再可管理，就从 `teamViewSelection` 里裁掉。

### 2. 与现有 batch UI 合同保持一致

这条修复直接复用 [PlmTeamViewsBlock.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/components/plm/PlmTeamViewsBlock.vue) 当前 checkbox 的 disabled 合同，不引入新的 actionability 判定。

### 3. 回归锁住只读刷新场景

[usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts) 新增 focused regression：

- 初始 refresh 返回可管理 team view，并被选中
- 下一次 refresh 返回同 id 但 `permissions.canManage = false`
- 旧 selection 会被清掉，`teamViewSelectionCount` 回到 `0`

## Files

- [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts)
- [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts)
- [PlmTeamViewsBlock.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/components/plm/PlmTeamViewsBlock.vue)

## Non-goals

- 不改变 batch action 的 archive/restore/delete 过滤规则
- 不改变 `Select all manageable` 的选择范围
- 不改变 team view 排序和默认视图逻辑
