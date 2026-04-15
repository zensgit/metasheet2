# MetaSheet 生产化加固 — PostgreSQL 持久化验证文档

Date: 2026-04-14

## 1. 交付总览

| PR | 内容 | 新建表 | 测试 | 状态 |
|---|---|---|---|---|
| #874 | 自动化执行日志 + 图表/Dashboard 持久化 | 3 | 129 | ✅ 已合并 |
| #875 | API Token + Webhook 持久化 | 3 | 41 | ✅ 已合并 |
| **合计** | | **6 张新表** | **170** | |

---

## 2. 新建 PostgreSQL 表

### 2.1 自动化执行日志

```sql
multitable_automation_executions (
  id, rule_id, triggered_by, triggered_at, status, steps JSONB,
  error, duration, created_at
)
-- Indexes: rule_id, status, created_at DESC
```

### 2.2 图表配置

```sql
multitable_charts (
  id, name, type, sheet_id, view_id, data_source JSONB,
  display JSONB, created_by, created_at, updated_at
)
-- Index: sheet_id
```

### 2.3 Dashboard 配置

```sql
multitable_dashboards (
  id, name, sheet_id, panels JSONB, created_by, created_at, updated_at
)
-- Index: sheet_id
```

### 2.4 API Token

```sql
multitable_api_tokens (
  id, name, token_hash UNIQUE, token_prefix, scopes JSONB,
  created_by, created_at, last_used_at, expires_at, revoked, revoked_at
)
-- Indexes: token_hash, created_by
```

### 2.5 Webhook

```sql
multitable_webhooks (
  id, name, url, secret, events JSONB, active, created_by,
  created_at, updated_at, last_delivered_at, failure_count, max_retries
)
-- Indexes: created_by, active (partial)
```

### 2.6 Webhook 投递历史

```sql
multitable_webhook_deliveries (
  id, webhook_id FK, event, payload JSONB, status, http_status,
  response_body, attempt_count, created_at, delivered_at, next_retry_at
)
-- Indexes: webhook_id, status (partial WHERE pending)
```

---

## 3. 迁移前后对比

| 服务 | 迁移前 | 迁移后 |
|---|---|---|
| ApiTokenService | 内存 Map | Kysely → PG `multitable_api_tokens` |
| WebhookService | 内存 Map | Kysely → PG `multitable_webhooks` + `_deliveries` |
| AutomationLogService | 内存循环缓冲 1000 条 | Kysely → PG `multitable_automation_executions` |
| DashboardService (charts) | 内存 Map | Kysely → PG `multitable_charts` |
| DashboardService (dashboards) | 内存 Map | Kysely → PG `multitable_dashboards` |

### 关键改进

- **数据持久化**：重启不丢失 token/webhook/日志/图表配置
- **全部 async/await**：路由处理器、中间件、服务方法全部异步化
- **事务支持**：`rotateToken()` 使用 DB 事务确保原子性
- **聚合查询**：`getStats()` 使用 `COUNT FILTER + AVG` 在 PG 层计算
- **日志清理**：`cleanup(retentionDays=30)` 自动清理过期执行日志
- **级联删除**：删除 webhook 自动清理投递历史（FK ON DELETE CASCADE）
- **删除图表清理面板**：deleteChart 同步移除 dashboard 中引用该图表的面板

---

## 4. 验收命令

```bash
cd packages/core-backend

# Token + Webhook 测试
npx vitest run tests/unit/api-token-webhook.test.ts --watch=false
# 41/41 通过

# 自动化测试
npx vitest run tests/unit/automation-v1.test.ts --watch=false
# 含日志服务测试

# 图表/Dashboard 测试
npx vitest run tests/unit/chart-dashboard.test.ts --watch=false
# 含 CRUD 持久化测试

# 迁移验证
npx vitest run tests/unit/ --watch=false
# 全量通过
```

---

## 5. 剩余生产化项目

| 项目 | 优先级 | 状态 |
|---|---|---|
| API Token → PG | P0 | ✅ 完成 |
| Webhook + 投递 → PG | P0 | ✅ 完成 |
| 自动化日志 → PG | P0 | ✅ 完成 |
| 图表/Dashboard → PG | P0 | ✅ 完成 |
| 限流器 → Redis | P1 | 待做（多实例部署时需要） |
| 自动化规则 → PG | P1 | 待做（当前规则仍在 EventBus 内存） |
