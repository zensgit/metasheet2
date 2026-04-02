# PLM Workbench Single-Target Takeover Selection Design

Date: 2026-03-25

## Problem

上一轮已经把 `applyTeamView()` 的 takeover 语义收口了：

- 应用新的 team view 前会清掉旧 batch selection

但另外两条同样会把页面切到“单一新 target”的路径还没对齐：

- `saveTeamView()`
- `duplicateTeamView()`

结果是：

1. 用户先在 Team views block 里勾选一批旧视角
2. 再执行 `Save current view` 或 `Duplicate`
3. 页面已经切到新的 `saved/duplicated` team view
4. 批量管理区却还保留旧选择

这会让“当前页面已经进入新视角”与“批量操作仍指向旧视角”同时存在。

## Design

### 1. save takeover 清 selection

在 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts) 的 `saveTeamView()` 里：

- `upsertTeamView(...)` 之后
- `applyView(saved)` 之前

显式执行：

- `teamViewSelection.value = []`

### 2. duplicate takeover 清 selection

在同文件的 `duplicateTeamView()` 里保持相同顺序：

- `upsertTeamView(...)`
- 清 `teamViewSelection`
- `applyView(duplicated)`

这样 save/duplicate/apply 三条“单目标 takeover”路径的 selection 语义一致。

## Why not clear in `applyView(...)`

`applyView(...)` 被更多路径复用，包括：

- `rename`
- `transfer`
- `clear default`
- `batch restore`

如果在 `applyView(...)` 里统一清 selection，会把并不属于 takeover 的路径也一起清掉，尤其会误伤批量 restore 这类仍然保留批量上下文的流程。

所以这轮只把 cleanup 放在明确的“切到一个新 target”入口里。

## Regression coverage

[usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts) 这轮锁了两类断言：

- `saveTeamView()` 成功后，旧 batch selection 被清掉，`requestedViewId` 和应用状态仍同步到新视角
- `duplicateTeamView()` 成功后，旧 batch selection 被清掉，页面仍切到新副本

## Files

- [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts)
- [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts)

## Non-goals

- 不改变 `rename / transfer / clear-default / batch restore` 的 selection 语义
- 不把 selection cleanup 泛化到所有 `applyView(...)` 调用点
