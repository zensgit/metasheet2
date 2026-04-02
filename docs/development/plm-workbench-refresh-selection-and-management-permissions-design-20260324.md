# PLM Workbench Refresh Selection And Management Permissions Design

Date: 2026-03-24

## Problem

`usePlmTeamViews` 在这轮 auto-apply 收口之后，还剩两类 concrete mismatch：

- refresh 后如果当前 `teamViewKey` 指向的视图仍存在，但已经 `permissions.canApply === false`，代码只会保留这份 stale 选择，不会把它清掉，也不会让默认视图接管。
- 多个管理 handler 仍直接看原始 `view.canManage`，而按钮和 actionability 早已在 [usePlmCollaborativePermissions.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmCollaborativePermissions.ts) 里转成 `permissions.canManage ?? canManage`。结果就是 UI 显示可点，handler 却回 `仅创建者可...`。

这轮我继续并行用了 `Claude Code` 做只读校验，它把这两条都明确指出来了。

## Design

### 1. refresh 先清 stale non-applyable selection

[usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts) 的 `refreshTeamViews()` 现在不只检查：

- 选中的 `teamViewKey` 是否还存在

还会继续检查：

- 这个 surviving target 是否仍然 `canApplyPlmCollaborativeEntry(...)`

如果 refresh 回来的目标已经不可 apply，就先清空 `teamViewKey`，再让后面的 `maybeAutoApplyDefault(...)` 决定是否接管默认视图。

### 2. 所有管理 handler 对齐 resolved `canManage`

这轮把下面几条 handler 从原始 `view.canManage` 统一切到了 `canManageSelectedTeamView.value`：

- `deleteTeamView()`
- `archiveTeamView()`
- `restoreTeamView()`
- `renameTeamView()`
- `setTeamViewDefault()`
- `clearTeamViewDefault()`

这样 handler 和 UI 不再说两套语义。

### 3. 用 focused tests 锁住两类行为

[usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts) 这轮新增回归：

- stale non-applyable selection 在 refresh 后会被清掉，并允许 default auto-apply 接管
- `permissions.canManage === true` 且 legacy `canManage === false` 时，`rename / set-default / clear-default / restore` 仍然可执行

## Files

- [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts)
- [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts)

## Non-goals

- 不改变 `save / duplicate` 的 apply 语义
- 不改后端权限模型
- 不改变 team view 排序或默认视图选择规则
