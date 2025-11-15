# packages/core-backend

v2 核心后端模块的最小骨架与实施清单。目标：在 monorepo 中沉淀审批引擎、鉴权/RBAC、审计与可观测性，并提供统一的 API 契约与迁移脚本。

## 目录规划（建议）

- src/
  - app/（应用装配：Express/Koa、路由注册、错误处理、JWT 中间件）
  - routes/（领域路由：approvals、roles、permissions、spreadsheets、files、audit-logs、metrics）
  - auth/（JWT 验证、白名单、用户上下文）
  - rbac/（角色与权限判定、资源粒度检查）
  - audit/（operation_audit_logs 写入封装、查询服务）
  - metrics/（Prometheus 指标注册与导出、HTTP 直方图、鉴权失败计数）
  - db/（PG 连接、迁移执行器、事务工具）
  - workflows/（审批引擎与状态跃迁、乐观锁协议）
  - utils/（日志、请求 ID、校验器）
- migrations/（SQL 与迁移脚本；编号延续 v1，含 031）

## M1 任务清单

- [ ] 数据库：`approval_instances.version` 与 `operation_audit_logs`（031），索引就绪
- [ ] 中间件：全局 JWT，白名单 `/api/auth/*`，`/metrics` 内部访问
- [ ] 审批路由：Approve/Reject/Return/Transfer/Sign/Revoke 采用事务+版本校验，冲突 409
- [ ] 审计：统一封装 `audit.log(...)`，写入关键写与敏感读；管理员查询 API
- [ ] RBAC：roles/permissions/spreadsheets/files/spreadsheet-permissions 全覆盖与审计
- [ ] 指标：`/metrics/prom` 暴露；`metasheet_approval_actions_total`、`metasheet_approval_conflict_total`、`jwt_auth_fail_total`、HTTP 直方图
- [ ] OpenAPI：路径与组件 Schema、bearerAuth、示例与错误码

## 审批乐观锁协议（摘要）

- 客户端提交写操作必须包含 `version`。
- 服务器校验 `current.version == request.version`；成功则 `version++` 并写入记录与审计；不匹配返回 409 和 `currentVersion`。

## 环境变量（占位）

- `DATABASE_URL`：Postgres 连接串
- `JWT_PUBLIC_KEY`/`JWT_SECRET`：鉴权
- `METRICS_ENABLED`：是否暴露指标端点

## 迁移（Migration）

使用内置迁移运行器：

- 执行迁移：`pnpm -F @metasheet/core-backend migrate`
- 可选排除：`MIGRATION_EXCLUDE=a.sql,b.sql pnpm -F @metasheet/core-backend migrate`

提示：CI 中 Observability/Migration Replay 可能会设置 `MIGRATION_EXCLUDE` 跳过较重的视图/审计表。
默认排除列表（CI）：`008_plugin_infrastructure.sql, 048_create_event_bus_tables.sql, 049_create_bpmn_workflow_tables.sql`
