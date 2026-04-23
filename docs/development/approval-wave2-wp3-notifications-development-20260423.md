# Approval Wave 2 WP3 slice 1 — 催办 + 待办红点 (开发记录)

- Date: 2026-04-23
- Branch: `codex/approval-wave2-wp3-notifications-20260423`
- Base: `origin/main@d1f35edf6`
- Scope owner: `docs/development/approval-mvp-wave2-scope-breakdown-20260411.md` §WP3

## 范围

WP3 slice 1 按飞书 Gap Matrix 里前两条可独立落地的差距拆分，优先落地“催办 + 红点”两项最小闭环，其余 WP3 项目（读/未读持久化、跨系统推送、真实通知通道）沿用 `approval-mvp-feishu-gap-matrix-20260411.md` 里的排序推到后续 slice。

- 催办 (remind / nudge)
- 消息红点 / 待办计数

## 后端契约

### 新端点 1：`POST /api/approvals/:id/remind`

- 独立路由，**不挂在** `/api/approvals/:id/actions` 联合处理器上。
  - 理由：`/actions` 由 `rbacGuard('approvals', 'act')` 守卫，而催办允许“**发起人**或持有 `approvals:act` 的审批人”。如果合进 `/actions`，发起人只持 `approvals:read` 时会在 guard 层就 403；路由内再派发还要额外区分 afterSales bridge / template runtime / PLM bridge 三条分支。拆独立端点后：HTTP guard 改为 `approvals:read`，路由内部再校验 `requester OR approvals:act`，且完全跳过状态机 / 跨系统派发流程。
- Body：允许为空 `{}`；目前不接受 `comment`，催办是事件而非意见。
- 403 场景：非 requester 且无 `approvals:act` 时返回 `APPROVAL_REMIND_FORBIDDEN`。
- 404 场景：instance id 不存在。
- 400 场景：`status != 'pending'` 时返回 `APPROVAL_REMIND_STATUS_INVALID`，避免对已完结审批记录噪声事件。
- 429 场景：同一 actor + 同一 instance 一小时内已有催办记录，直接返回 `APPROVAL_REMIND_THROTTLED`，响应体携带 `lastRemindedAt` 与 `retryAfterSeconds=3600`，前端以 toast 形式提示“已在 N 分钟前催办过”。
- 200 成功：
  - 写入一行 `approval_records`，`action='remind'`，`from_status = to_status = 'pending'`，`from_version = to_version = 0`（催办不推进流程）。
  - `metadata = { remindedBy, remindedAt, sourceSystem, bridged:false }`。
  - 响应体 `{ ok:true, data:{ id, action:'remind', remindedAt, bridged, sourceSystem } }`。

### 速率限制实现

使用 Postgres 侧的 `occurred_at > now() - INTERVAL '1 hour'` 作为判据。时钟与实际记录时间来自同一个数据库会话，不依赖客户端时钟；事务语义保证了“读取 + 插入”串行。

### 新端点 2：`GET /api/approvals/pending-count`

- Query：`sourceSystem = platform | plm | all`（默认 `all`）。
- 返回：`{ count: number }`。
- 语义：**对当前用户活跃的 `approval_assignments`（`is_active=TRUE`）** 计数，连接 `approval_instances` 过滤 `status='pending'`，并按 `sourceSystem` 可选过滤。同时包含 user 与 role 两种 assignment_type；actor 的角色集合由 `req.user.roles` 传入。
- 与 LIST 的 PLM 分支有显著差异：LIST 在 `sourceSystem=plm` 且 `tab=pending` 时跳过 assignment join，用 `status='pending'` 直接呈现 PLM pending 队列（phase 1 限制）；但红点的契约定义是“当前用户活跃的 assignment 数量”，因此 pending-count 对所有来源统一使用 assignment join。两者的语义差异在 WP2 文档里已有明确边界，pending-count 不回退到 LIST 的妥协方案。
- 输入错误：未知的 `sourceSystem` 返回 400 `APPROVAL_SOURCE_SYSTEM_INVALID`（与 LIST 的错误码一致）。

### 数据库迁移

`packages/core-backend/src/db/migrations/zzzz20260423120000_add_remind_action_to_approval_records.ts`：在 `approval_records_action_check` 里加 `'remind'`，复用 `zzzz20260411123000_add_created_action_to_approval_records.ts` 的 `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` 的模板。

测试端也同步更新 `packages/core-backend/tests/helpers/approval-schema-bootstrap.ts`，并把 bootstrap version 推进到 `20260423-wp3-remind-action`，确保并行 worker 会重新应用最新 DDL。

## 前端改动

### `apps/web/src/views/approval/ApprovalCenterView.vue`

- 新增独立状态 `pendingBadgeCount`，由 `getPendingCount()` 端点驱动。故意不复用 store 里已有的 `pendingCount`（那是当前页列表长度，不是全局 assignment 数），避免切页时红点跟着跳。
- 在 `待我处理` tab 的 `#label` 插槽里渲染 `<el-badge :value="pendingBadgeCount" :max="99" data-testid="approval-pending-badge" />`，仅当 `pendingBadgeCount > 0` 才渲染。
- 挂载时 + tab 切换时刷新，sourceSystem 与列表过滤共享 `sourceSystemFilter` 的值，保证红点和列表严格一致。
- 红点获取失败时不显示 toast（红点是装饰信息；列表加载错误仍通过 `store.error` 暴露）。

### `apps/web/src/views/approval/ApprovalDetailView.vue`

- 在 requester 看到的 actions-secondary 里新增 `催一下` 按钮（data-testid=`approval-remind-button`）。
- 状态机：
  - 200 → `ElMessage.success('已催办')`，并触发 `store.loadHistory(id)` 把新事件追加到时间线。
  - 429 → `ElMessage.warning('已在 N 分钟前催办过')`，由 `lastRemindedAt` 换算出“分钟/小时前”。
  - 其他错误 → 通用 `ElMessage.error('催办失败，请重试')`。
- 使用独立的 `remindLoading` ref，不和审批动作的 `store.loading` 串联，避免“催一下”旋转影响 approve/reject 按钮。

### `apps/web/src/approvals/api.ts`

- 新增 `getPendingCount(sourceSystem)` + `remindApproval(id)`。
- `remindApproval` 用原生 `apiFetch` 而不是 `apiPost`，这样 429 状态码能保留 `lastRemindedAt` 等字段交给 UI 层。

## 显式 defer（未进入此 slice）

- **读/未读（per user per instance）**：需要新建 `approval_reads` 表和读写路径，超出 slice 1 目标；slice 1 的“未读”口径近似为“当前用户仍有活跃 assignment”。
- **PLM 催办外推**：PLM 目前不接受催办事件；此 slice 把 PLM 源的 instance 本地记录 `bridged:false`，不调用 `plmAdapter`。
- **外部通知通道（IM / 邮件 / push）**：是 Phase 3 Notification Hub 的职责，本 slice 仅记录事件，不引入 `NotificationService` 或 `notification_topics` 表。
- **抄送我的 / 已完成等 tab 的红点**：当前只覆盖 `待我处理`；其他 tab 不渲染红点，后续若需要再扩 endpoint。
- **多端同步**：前端仅做“挂载时 + tab 切换时”拉取；WebSocket 推送与 WebView 多实例一致性是后续 slice 的任务。

## 风险 / 已知副作用

- `ensureApprovalSchemaReady` 的 `APPROVAL_SCHEMA_BOOTSTRAP_VERSION` 推进后，未清理的旧 worker DB 会在 `ADD CONSTRAINT` 前先 DROP，过程内有短暂的 CHECK 缺失窗口——由 advisory lock 保障单 worker 串行。
- 催办未推进状态机，因此 `to_version = 0` 的行会出现在 `approval_records` 中；前端历史视图原本不显示 `remind` 动作，此 slice 不改历史视图排序规则；后续 slice 如果要展示催办徽章，可基于 `metadata.remindedAt` 检索最近一次催办。

## Feishu Gap 进度

- 催办：差距位 `❌` → `部分`（仅记录，未推送）
- 消息红点 / 计数：差距位 `❌` → `部分`（待办红点已可用，其他 tab 红点未覆盖）
- 已读/未读：仍为 `❌`（本 slice 不碰）
