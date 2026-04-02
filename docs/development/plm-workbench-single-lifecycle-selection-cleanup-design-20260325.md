# PLM Workbench Single Lifecycle Selection Cleanup Design

Date: 2026-03-25

## Problem

`deleteTeamView()` 和 `archiveTeamView()` 都属于“当前 target 被单独移出当前工作态”的 lifecycle action：

- `delete` 会直接把当前视角移除
- `archive` 会清掉当前 route owner，并把视角切进归档态

但这两条路径之前不会同步清理该 id 在 `teamViewSelection` 里的残留。结果是：

1. 用户先勾选当前 team view
2. 再点 single `Delete` 或 `Archive`
3. 页面已经离开当前视角
4. batch manager 仍继续显示“已选 1 项”

这是单目标 lifecycle action 和 batch state 混在一起的典型残留。

## Design

在 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts) 里：

- `deleteTeamView()` 成功后，从 `teamViewSelection` 里移除 `view.id`
- `archiveTeamView()` 成功后，也从 `teamViewSelection` 里移除 `view.id`

实现保持最小范围：

- 只移除被 single action 命中的当前 id
- 不清掉其它仍然有效的批量选择

## Why not affect restore

`restoreTeamView()` 是把当前 archived target 重新带回活跃状态，并重新应用到 route：

- 当前 target 仍然是同一个 id
- 不属于“离开当前目标”的 lifecycle action

所以这轮只处理 `delete/archive`，不动 `restore`。

## Regression coverage

[usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts) 这轮补了两条 focused 断言：

- single `Delete` current workbench team view 后，selection 会清空
- single `Archive` current workbench team view 后，selection 会清空

## Files

- [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts)
- [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts)
