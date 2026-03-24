# PLM Workbench Refresh Name Draft Cleanup Design

Date: 2026-03-24

## Problem

`refreshTeamViews()` 之前在清掉失效 `teamViewKey` 时，没有同步清掉 `teamViewName`。

这会留下两类真实残留：

- selected team view 被 refresh 移除后，旧的 name draft 还留在输入框里
- selected team view 仍存在但已经 `canApply === false` 时，refresh 会清 key 并允许 default takeover，但旧的 name draft 还会继续挂着

这和文件里其他会清 selection 的路径不一致：

- `deleteTeamView()`
- `archiveTeamView()`
- `runBatchTeamViewAction()`

这些路径都会在 `teamViewKey = ''` 时同步清 `teamViewName = ''`。

这轮我继续并行用了 `Claude Code` 做只读校验，它明确确认了这条 stale name-draft bug。

## Design

### 1. refresh deselect 时同步清 name draft

[usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts) 的 `refreshTeamViews()` 现在在下面两条分支里都同步执行：

- `teamViewKey.value = ''`
- `teamViewName.value = ''`

对应场景：

- selected view 不再存在
- selected view 仍存在，但已经不再可 apply

### 2. 保持与其他 lifecycle cleanup 一致

这次不引入新的状态机，只是把 refresh 路径补齐到文件里已有的 cleanup 合同。

### 3. 回归锁住两个 refresh 分支

[usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts) 新增/加强：

- stale non-applyable selection fallback 到 default 时，旧 `teamViewName` 会被清空
- selected view 被 refresh 移除时，旧 `teamViewName` 也会被清空

## Files

- [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts)
- [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts)

## Non-goals

- 不改变 `teamViewOwnerUserId` 的管理草稿合同
- 不改变 save/rename 的输入合法性
- 不改变 default auto-apply 或 requested route 解析规则
