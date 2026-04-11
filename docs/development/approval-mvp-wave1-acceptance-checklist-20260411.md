# 审批 MVP 第一波验收清单

> 日期: 2026-04-11
> 分支: origin/main
> 类型定义: `apps/web/src/types/approval.ts`
> OpenAPI: `packages/openapi/src/paths/approvals.yml`
> 路由: `apps/web/src/router/appRoutes.ts`

---

## 模板管理

- [ ] 创建审批模板（填写 key、名称、描述、表单 schema、审批图），返回 201 + `ApprovalTemplateDetail`
- [ ] 模板 key 唯一性校验（重复 key 返回 400）
- [ ] 编辑模板（PATCH 更新名称/描述/表单/审批图），自动创建新版本
- [ ] 编辑已发布模板不影响已有审批实例（快照隔离）
- [ ] 发布模板（POST publish + RuntimePolicy），状态变为 published，生成 `published_definition`
- [ ] 发布时必须提供 `policy`（`allowRevoke` + 可选 `revokeBeforeNodeKeys`），缺失返回 400
- [ ] 模板列表 GET 返回分页数据（items / total / limit / offset）
- [ ] 模板列表支持 `search` 关键字搜索（名称模糊匹配）
- [ ] 模板列表支持 `status` 过滤（draft / published / archived）
- [ ] 模板详情 GET 返回 `formSchema` + `approvalGraph`
- [ ] 已发布模板在模板中心页面显示"发起审批"入口
- [ ] 模板详情页展示表单字段列表和审批流程图（节点 + 边）
- [ ] 版本查询 GET `/api/approval-templates/{id}/versions/{versionId}` 返回 `ApprovalTemplateVersionDetail`
- [ ] 已发布版本的 `runtimeGraph` 不为 null，包含 `policy`
- [ ] 草稿版本的 `runtimeGraph` 为 null，`publishedDefinitionId` 为 null
- [ ] 未授权用户访问模板接口返回 401
- [ ] 无 `approval-templates:manage` 权限的用户创建/编辑/发布模板返回 403

## 审批发起

- [ ] 按已发布模板发起审批 POST `/api/approvals`，传入 `templateId` + `formData`
- [ ] 动态渲染 9 种表单字段（text / textarea / number / date / datetime / select / multi-select / user / attachment）
- [ ] 必填字段校验：`required: true` 的字段缺失时返回 400
- [ ] 类型校验：number 字段传字符串返回 400
- [ ] select 字段枚举合法性校验：值不在 options 范围内返回 400
- [ ] multi-select 字段枚举合法性校验：任一值不在 options 范围内返回 400
- [ ] 提交成功后返回 201 + `UnifiedApprovalDTO`
- [ ] 返回数据包含审批编号 `requestNo`（格式 AP-XXXXXX）
- [ ] 返回数据包含 `templateId`、`templateVersionId`、`publishedDefinitionId`
- [ ] 返回数据包含 `formSnapshot`（提交时的表单数据快照）
- [ ] 提交成功后前端跳转到审批详情页 `/approvals/:id`
- [ ] 向未发布模板发起审批返回 409
- [ ] 模板 ID 不存在返回 404
- [ ] 无 `approvals:write` 权限的用户发起审批返回 403

## 审批中心

- [ ] 审批中心页面路由 `/approvals` 正确加载 `ApprovalCenterView.vue`
- [ ] 待审批 Tab（pending）：`assignee=当前用户ID` + `status=pending` 查询
- [ ] 我发起的 Tab（mine）：`requesterId=当前用户ID` 查询
- [ ] 抄送我 Tab（cc）：`ccRecipientId=当前用户ID` 查询
- [ ] 已完成 Tab（completed）：`status=approved,rejected,revoked` 查询
- [ ] 列表分页正确（limit / offset / total）
- [ ] 列表项显示审批标题、状态、发起人、创建时间
- [ ] 点击列表项跳转到审批详情页
- [ ] 无 `approvals:read` 权限的用户查看列表返回 403

## 审批详情

- [ ] 审批详情页路由 `/approvals/:id` 正确加载 `ApprovalDetailView.vue`
- [ ] 详情页展示审批基本信息（标题、编号、状态、发起人、当前步骤）
- [ ] 详情页展示表单快照（formSnapshot）
- [ ] 详情页展示审批历史时间线（GET `/api/approvals/{id}/history`）
- [ ] 历史时间线显示操作类型、操作人、评论、时间
- [ ] 历史分页正确（page / pageSize / total）
- [ ] 审批实例不存在返回 404
- [ ] 当前用户为审批人时显示操作按钮（审批/驳回/转交）
- [ ] 当前用户为发起人时显示撤回按钮（如 policy 允许）

## 审批操作 — 统一 Action 接口

- [ ] **审批通过** POST `/api/approvals/{id}/actions` `{ "action": "approve" }` → 状态流转正确
- [ ] **审批通过** 可附带 comment
- [ ] **驳回** POST `{ "action": "reject", "comment": "..." }` → 状态变为 rejected
- [ ] **转交** POST `{ "action": "transfer", "targetUserId": "..." }` → 审批人变更
- [ ] **转交** 必须提供 `targetUserId`，缺失返回 400
- [ ] **撤回** POST `{ "action": "revoke" }` → 状态变为 revoked
- [ ] **撤回** 仅发起人可操作，非发起人返回 403
- [ ] **撤回** 当 `policy.allowRevoke = false` 时返回 409
- [ ] **撤回** 当配置了 `revokeBeforeNodeKeys` 且当前节点不在范围内时返回 409
- [ ] **评论** POST `{ "action": "comment", "comment": "..." }` → 添加评论历史记录
- [ ] **评论** 不改变审批状态
- [ ] 无效 action 类型返回 400
- [ ] 非当前审批人执行 approve/reject 返回 403
- [ ] 无 `approvals:act` 权限执行操作返回 403

## 并发串行化（Row Lock Serialization）

- [ ] 并发操作同一审批实例时，统一 action 端点通过数据库行锁串行化写入，不发生双写覆盖
- [ ] `POST /api/approvals/{id}/actions` 不要求客户端提交 `version`
- [ ] 后续请求若在前序动作提交后已不满足当前状态约束，应返回 409 类冲突（如状态跃迁非法、撤回窗口关闭），而不是写入脏状态

## 权限模型

- [ ] `approvals:read` — 仅允许查看审批列表和详情
- [ ] `approvals:write` — 允许发起审批
- [ ] `approvals:act` — 允许执行审批操作（approve/reject/transfer/revoke/comment）
- [ ] `approval-templates:manage` — 允许创建/编辑/发布模板
- [ ] 权限码在 `APPROVAL_PRODUCT_PERMISSIONS` 常量中冻结
- [ ] 无任何审批权限的用户访问审批相关接口返回 403
- [ ] 只读用户（仅 `approvals:read`）可以查看列表和详情但不能操作

## 前端路由

- [ ] `/approvals` → `ApprovalCenterView.vue`（审批中心）
- [ ] `/approvals/new/:templateId` → `ApprovalNewView.vue`（发起审批）
- [ ] `/approvals/:id` → `ApprovalDetailView.vue`（审批详情）
- [ ] `/approval-templates` → `TemplateCenterView.vue`（模板中心）
- [ ] `/approval-templates/:id` → `TemplateDetailView.vue`（模板详情）
- [ ] 所有审批路由 `requiresAuth: true`

## 兼容性

- [ ] PLM 审批桥接仍然正常工作（`plm:` 前缀的审批 ID 走 PLM 适配器）
- [ ] 考勤插件仍然正常工作（不受审批功能影响）
- [ ] WorkflowHub 页面仍可访问（`/workflows` 路由正常）
- [ ] 旧版单操作接口（approve/reject/return/revoke）标记为 deprecated 但仍可用
- [ ] `/api/approvals/pending` 接口标记为 deprecated 但仍可用

## API 响应格式一致性

- [ ] 所有成功响应包含 `{ ok: true, data: ... }` 结构
- [ ] 所有错误响应包含 `{ ok: false, error: { code, message } }` 结构
- [ ] 分页列表响应包含 `items` + `total` + `limit` + `offset`（或 `page` + `pageSize`）
- [ ] 日期字段统一使用 ISO 8601 格式

## 数据完整性

- [ ] 创建的审批实例包含 `sourceSystem: 'platform'`
- [ ] 审批实例的 `assignments` 数组正确反映当前审批人
- [ ] 审批操作后 `updatedAt` 时间戳更新
- [ ] 历史记录的 `occurredAt` 时间戳正确
- [ ] 审批状态流转正确：`pending` → `approved` / `rejected` / `revoked`

---

## 总计: 80+ 验收项

| 类别 | 验收项数 |
|------|---------|
| 模板管理 | 17 |
| 审批发起 | 14 |
| 审批中心 | 9 |
| 审批详情 | 9 |
| 审批操作 | 14 |
| 乐观锁 | 3 |
| 权限模型 | 7 |
| 前端路由 | 6 |
| 兼容性 | 5 |
| 响应格式 | 4 |
| 数据完整性 | 5 |
