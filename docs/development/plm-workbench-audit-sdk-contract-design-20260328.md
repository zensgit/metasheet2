# PLM Workbench Audit SDK Contract Design

## Background

`plm-workbench` 的 collaborative route 里，`team view / team preset` 直连 API 已经在上一轮接入了 runtime SDK，但 `audit-logs` 这条 JSON 读取链还停留在手写 Web fetch：

- `GET /api/plm-workbench/audit-logs`
- `GET /api/plm-workbench/audit-logs/summary`

这让当前仓库存在两份独立 contract：

- source OpenAPI / dist SDK
- `apps/web/src/services/plm/plmWorkbenchClient.ts` 的手写 query、unwrap、error fallback

## Problem

这条分叉会带来两个具体问题：

1. `audit` JSON route 没有进入 `plm-workbench` source OpenAPI，SDK 无法作为单一 typed runtime 入口复用。
2. Web 层继续手写 `page/pageSize/resourceTypes` contract，后续 route 字段变化时会再次出现 “OpenAPI 已更新但 Web 运行时没跟上” 的 drift。

## Decision

把 `audit` JSON route 也纳入与 collaborative route 同一条 contract 链：

- source OpenAPI 暴露 `audit-logs` / `audit-logs/summary`
- `dist-sdk` runtime client 提供 typed helper
- Web collaborative audit client 改为委托 SDK helper

`export.csv` 维持手写 fetch，不强行塞进 JSON runtime client，因为它的 transport 是文件下载而不是 JSON envelope。

## Implementation

### OpenAPI

在 `packages/openapi/src/paths/plm-workbench.yml` 新增：

- `collaborativeAuditMeta`
- `collaborativeAuditLogItem`
- `collaborativeAuditSummaryRow`

并正式暴露：

- `/api/plm-workbench/audit-logs`
- `/api/plm-workbench/audit-logs/summary`

这样 source OpenAPI、`dist/openapi.yaml` 和 `dist-sdk/index.d.ts` 都能看到这两个路径。

### dist-sdk runtime

在 `packages/openapi/dist-sdk/client.ts` 新增：

- `PlmCollaborativeAuditResourceType`
- `ListPlmCollaborativeAuditLogsParams`
- `GetPlmCollaborativeAuditSummaryParams`
- `PlmCollaborativeAuditLogsResponse`
- `PlmCollaborativeAuditSummaryResponse`

以及两个 runtime helper：

- `listCollaborativeAuditLogs(...)`
- `getCollaborativeAuditSummary(...)`

其中 `listCollaborativeAuditLogs(...)` 明确按 `page/pageSize` 建模，而不是复用已有的 `limit/offset` 分页抽象，避免 transport 语义错位。

### Web migration

`apps/web/src/services/plm/plmWorkbenchClient.ts` 现在只保留：

- UI-facing filter normalization
- log item / summary row normalization
- CSV export fetch

而 JSON audit list/summary 请求统一委托给 `createPlmWorkbenchClient(...)`。

## Why this is better

- `audit` route 终于和 team view / team preset collaborative route 站到同一条 SDK contract 链上。
- Web 不再维护第二份 audit JSON path/query contract。
- `page/pageSize`、`resourceTypes metadata`、summary shape 都由 SDK helper 直接承接，减少后续 drift 面。
- `export.csv` 继续保持独立，不把文件下载错误地揉进 JSON helper，边界更清楚。
