# PLM Workbench Transfer Selection Cleanup Design

Date: 2026-03-25

## Problem

`transferTeamView()` 成功后，当前视角通常会从“我可管理”变成“只读可见”：

- `ownerUserId` 变成新 owner
- `canManage` / `permissions.canManage` 变为 `false`

但本地 `teamViewSelection` 之前不会同步裁掉这个 id。结果是：

1. 用户批量勾选了 `A`、`B`
2. 再单独把 `A` 转移给别人
3. 页面会正确切到新的只读 `A`
4. 但批量管理仍显示“已选 2 项”，其中 `A` 已经不再可管理

这会把只读目标继续留在 batch manager 计数里，形成明显的 stale selection。

## Design

在 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts) 的 `transferTeamView()` 里：

- `replaceTeamView(...)` 后读取 `saved`
- 如果 `saved` 已经不再可管理
- 就从 `teamViewSelection` 里移除 `saved.id`

实现上复用现有 `canManageTeamView(...)` helper，确保：

- legacy `canManage`
- `permissions.canManage`

两套来源都能被一致处理。

## Why not clear all selection

这条路径不是“切到新 target 的 takeover”，而是“当前选中项失去 manageability”：

- 被转移出去的当前视角应当移出 selection
- 其它仍然有效的选中项应继续保留

所以这轮只裁掉 `saved.id`，不把整个 batch selection 清空。

## Regression coverage

[usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts) 这轮把现有 transfer success case 收紧成：

- 初始 selection 为 `['document-view-1', 'document-view-2']`
- `document-view-1` 转移后变只读
- 最终 selection 只保留 `document-view-2`

## Files

- [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts)
- [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts)
