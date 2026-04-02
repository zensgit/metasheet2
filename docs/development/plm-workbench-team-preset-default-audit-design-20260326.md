# PLM Workbench Team Preset Default Audit Parity Design

## Background

`team preset` 的 `set-default / clear-default` 路由已经有 owner、tenant、scope、archived guard，但仍然没有像 `team view default` 那样写入 `operation_audit_logs`。这会导致：

- `PLM Audit` 看不到团队预设默认切换
- 审计筛选 `resourceType` 无法单独筛出团队预设默认动作
- `team preset` 响应也拿不到最近一次 `set-default` 信号

## Target

把 `team preset default` 拉齐到 `team view default` 的 canonical 合同：

1. 后端路由在 `set-default / clear-default` 成功后写入单条审计事件。
2. 审计事件使用独立 `resourceType = plm-team-preset-default`，不再混入 batch lifecycle。
3. 团队预设列表与默认路由响应能 hydrate `last_default_set_at`。
4. 前端 audit client、query state、saved views、筛选 UI 都能识别新资源类型。

## Design

### 1. Backend audit resource contract

在 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/core-backend/src/routes/plm-workbench.ts) 中：

- 扩展 `PlmCollaborativeAuditResourceType`，新增 `plm-team-preset-default`
- 扩展 `normalizePlmAuditResourceType(...)`
- 新增 `logPlmTeamPresetDefaultAudit(...)`

日志结构与 `team view default` 对齐：

- `route = /api/plm-workbench/filter-presets/team/:id/default`
- `resourceType = plm-team-preset-default`
- `action = set-default | clear-default`
- `resourceId = presetId`
- `meta.kind`
- `meta.viewName` 复用现有通用字段承载 preset name
- `meta.processedKinds / requestedTotal / processedTotal / skippedTotal`

### 2. Backend default signal hydration

新增 `attachPlmTeamPresetDefaultSignals(...)`：

- 从 `operation_audit_logs` 查询 `resource_type = plm-team-preset-default AND action = set-default`
- 聚合 `MAX(COALESCE(occurred_at, created_at))`
- 回灌到 `last_default_set_at`

这套 hydration 用在：

- `GET /api/plm-workbench/filter-presets/team`
- `POST /api/plm-workbench/filter-presets/team/:id/default`
- `DELETE /api/plm-workbench/filter-presets/team/:id/default`

同时在 [plmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/core-backend/src/plm/plmTeamFilterPresets.ts) 里把 `last_default_set_at -> lastDefaultSetAt` 暴露到 API 映射结果。

### 3. Frontend audit resource parity

在这些文件里补齐 `plm-team-preset-default`：

- [plmWorkbenchClient.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/services/plm/plmWorkbenchClient.ts)
- [plmAuditQueryState.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditQueryState.ts)
- [plmAuditSavedViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditSavedViews.ts)
- [PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue)

结果是：

- audit log 列表不会把新资源类型丢弃
- summary buckets 会保留该类型
- saved view / shared route 能 round-trip 该类型
- audit 筛选 UI 可直接筛 `Team preset default`

## Non-goals

- 不改动 `team preset batch` 既有 lifecycle 审计格式
- 不改动审批或 team view 默认审计语义
- 不引入新的 OpenAPI schema 字段；本次只增强既有 runtime contract
