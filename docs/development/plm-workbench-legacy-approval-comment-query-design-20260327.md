# PLM Workbench Legacy Approval Comment Query Design

## Background

`approvalComment` 已经被定义为本地审批草稿，不应参与 collaborative snapshot、share URL、default blocker 或 canonical route state。

当前实现虽然会在这些路径里删除它，但 `PLM_WORKBENCH_QUERY_KEYS` 仍把它当作 canonical query key 接收，形成“先识别、后清理”的遗留耦合。

## Problem

- `normalizePlmWorkbenchQuerySnapshot(...)` 仍会把 `approvalComment` 纳入 canonical snapshot。
- 随后各个上层 helper 再分别 `delete next.approvalComment`，语义分散且容易漏口。
- legacy URL purge helper 又依赖 canonical query normalization，导致无法直接把 `approvalComment` 从 query schema 中摘掉。

## Decision

- 将 `approvalComment` 从 `PLM_WORKBENCH_QUERY_KEYS` 中移除。
- 保留 `buildPlmWorkbenchLegacyLocalDraftQueryPatch(...)`，但改为直接检查原始 query 对象里的 `approvalComment`，不再依赖 canonical normalization。

## Expected Result

- canonical workbench query schema 不再接受 `approvalComment`。
- collaborative/local/default/explicit-blocker 逻辑不再需要先解析这个 legacy key 再删除。
- 旧 URL 仍然会被识别并清理，兼容性不回退。
