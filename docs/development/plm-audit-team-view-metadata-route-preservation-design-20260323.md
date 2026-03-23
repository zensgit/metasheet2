# PLM Audit Team View Metadata Route Preservation Design

## Context

`PLM Audit` 里的 team-view 管理动作并不全都应该改变 route。

- `save / duplicate / apply / set-default / clear-default / archive / restore / delete` 会显式切到 selected view 或 matching audit logs，这是预期的 route pivot。
- `rename / transfer owner` 只是修改 team view 元数据，本质上是 metadata-only action。

当前实现里，这两个 metadata-only action 在成功后也会调用 `applyAuditTeamViewState(saved)`，把本地页面状态直接切成 team-view snapshot。这样在默认变更日志、协作 followup 或其它 log route 上执行 rename/transfer 时，会出现 route 仍停在 logs、但本地筛选输入已经切回 team-view snapshot 的分叉状态。

## Goal

让 `rename / transfer owner` 只更新列表项、选择态和 focus，不触碰当前 route/filter/log context。

## Design

### Metadata-only actions keep the current route

`renameAuditTeamView()` 和 `transferAuditTeamView()` 改成：

- 继续更新 team view 列表项
- 继续刷新 management attention
- 继续把 selector/focus 锁回目标 team view
- 不再调用 `applyAuditTeamViewState(saved)`

这样当前页面如果处于：

- selected team-view route：route 本来就正确，不需要重复切换
- default-change / clear-default / lifecycle logs：route 会继续保持在 logs 上，不会被 metadata-only action 本地覆盖
- collaboration followup：followup 所在上下文不再被 metadata-only action 破坏

### Local selection remains stable

为此增加一个轻量的本地 helper，只负责：

- `auditTeamViewKey`
- `focusedAuditTeamViewId`

metadata-only action 只更新这两个选择相关字段，不再动 query/filter state。

## Files

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue`

## Non-Goals

- 不改变 rename / transfer owner 的权限判断。
- 不调整 followup 生命周期或 route watcher cleanup 规则。
- 不为 metadata-only action 新增 audit log pivot。
