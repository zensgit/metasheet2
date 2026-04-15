# MetaSheet Phase 1 平台基础收口 — 设计及验证文档

Date: 2026-04-15

## 1. 交付总览

| PR | 内容 | 测试 | 状态 |
|---|---|---|---|
| #878 | 限流器 → Redis 可插拔 Store | 15 | ✅ 已合并 |
| #879 | 自动化规则 → PostgreSQL | 91 | ✅ 已合并 |
| — | 平台壳 wave1 | — | ✅ 已在 main（PR #852） |

---

## 2. 限流器 Redis 升级 (PR #878)

### 2.1 设计：可插拔 Store 接口

```typescript
interface RateLimitStore {
  increment(key: string, windowMs: number): Promise<{ count: number, ttlMs: number }>
  destroy?(): void
}
```

| 实现 | 说明 | 适用场景 |
|---|---|---|
| `MemoryRateLimitStore` | Map-based 固定窗口 | 单实例 / 开发环境 |
| `RedisRateLimitStore` | `INCR` + `EXPIRE` 原子操作 | 多实例生产环境 |

### 2.2 Redis 连接

```typescript
// packages/core-backend/src/db/redis.ts
getRedisClient()   // 懒初始化 ioredis，REDIS_URL 配置
closeRedisClient() // 优雅关闭
```

- 环境变量 `REDIS_URL`，默认 `redis://localhost:6379`
- Redis 不可用时自动降级到内存 Store + console.warn

### 2.3 向后兼容

现有消费者 `publicFormSubmitLimiter` / `publicFormContextLimiter` / `conditionalPublicRateLimiter` 导出 API **不变**。Redis 注入是可选的。

### 2.4 验收

```bash
cd packages/core-backend
npx vitest run tests/unit/rate-limiter.test.ts --watch=false
# 15/15 通过
```

---

## 3. 自动化规则持久化 (PR #879)

### 3.1 设计：Kysely CRUD + 调度器同步

**迁移**：扩展现有 `automation_rules` 表
- 新增 `conditions` JSONB 列
- 新增 `actions` JSONB 列
- 扩展 CHECK 约束支持全部 V1 触发器和动作类型

**AutomationService 重构：**

| 方法 | 变更 |
|---|---|
| `createRule()` | raw SQL → Kysely INSERT + 自动注册调度 |
| `getRule()` | raw SQL → Kysely SELECT |
| `listRules()` | raw SQL → Kysely SELECT WHERE sheet_id |
| `updateRule()` | raw SQL → Kysely UPDATE RETURNING + 重新注册调度 |
| `deleteRule()` | raw SQL → Kysely DELETE + 取消调度注册 |
| `setRuleEnabled()` | 新增 — UPDATE enabled + 调度器同步 |
| `loadAndRegisterAllScheduled()` | 新增 — 启动时加载所有已启用的定时规则 |
| `loadEnabledRules()` | raw SQL → Kysely |

**构造函数**：接受 `Kysely<Database>` 作为第二参数

**启动流程**：`index.ts` 中 `AutomationService` 初始化后自动调用 `loadAndRegisterAllScheduled()`，确保服务重启后定时规则恢复运行。

### 3.2 DB 类型

```typescript
// db/types.ts
interface AutomationRulesTable {
  id: string
  sheet_id: string
  name: string
  trigger_type: string
  trigger_config: JSONB
  action_type: string
  action_config: JSONB
  conditions: JSONB | null
  actions: JSONB | null
  enabled: boolean
  created_by: string
  created_at: CreatedAt
  updated_at: UpdatedAt
}
```

已注册到 `Database` 接口。

### 3.3 路由更新

`univer-meta.ts` 中的自动化 CRUD 端点（GET/POST/PATCH/DELETE）已从 `pool.query` 迁移到 `kyselyDb`。触发器和动作类型验证集已扩展支持全部 V1 类型。

### 3.4 验收

```bash
cd packages/core-backend
npx vitest run tests/unit/automation-v1.test.ts --watch=false
# 91/91 通过
```

---

## 4. 平台壳 Wave1（已在 main）

通过 PR #852 已合并，包含：

| 模块 | 文件 | 说明 |
|---|---|---|
| App Manifest | `app-manifest.ts` | Zod 验证的应用清单 schema |
| App Registry | `app-registry.ts` | 从插件目录读取 manifest，缓存摘要 |
| Instance Registry | `PlatformAppInstanceRegistryService.ts` | PostgreSQL per-tenant 应用实例 |
| API Router | `platform-apps.ts` | `GET /api/platform/apps`, `GET /api/platform/apps/:appId` |
| Frontend Composable | `usePlatformApps.ts` | 响应式应用列表，安装状态跟踪 |
| Launcher View | `PlatformAppLauncherView.vue` | 统一应用导航 |
| Shell View | `PlatformAppShellView.vue` | 应用壳加载 |
| DB Migration | `platform_app_instances` 表 | — |
| Plugin Manifests | after-sales, attendance | — |

---

## 5. Phase 1 完成度总结

| 计划项 | 状态 | PR |
|---|---|---|
| 平台壳稳定化 | ✅ | #852 |
| 钉钉身份层（SSO/目录同步） | ✅ | #870-#876 (Codex) |
| 8 周路线图 Week 0-8 | ✅ | #856-#869 |
| 生产化：5 服务 → PG | ✅ | #874-#875 |
| 生产化：自动化规则 → PG | ✅ | #879 |
| 生产化：限流器 → Redis | ✅ | #878 |
| 代码审核 bug 修复 | ✅ | `b939fc34e` |

**Phase 1 全部完成。**

---

## 6. 全量 PostgreSQL 表清单（本轮新增）

| 表名 | 来源 | 说明 |
|---|---|---|
| `multitable_automation_executions` | #874 | 执行日志 |
| `multitable_charts` | #874 | 图表配置 |
| `multitable_dashboards` | #874 | Dashboard 面板 |
| `multitable_api_tokens` | #875 | API Token hash |
| `multitable_webhooks` | #875 | Webhook 配置 |
| `multitable_webhook_deliveries` | #875 | 投递历史 |
| `automation_rules` (扩展) | #879 | 规则 + conditions/actions JSONB |
| `platform_app_instances` | #852 | 平台应用实例 |

---

## 7. 下一步：Phase 2 规划

Phase 2（2026-05-11 → 2026-06-14）核心任务：

| 优先级 | 项目 | 工作量 | 说明 |
|---|---|---|---|
| P0 | CRDT/OT 实时协同编辑 | XL | 需要专项技术方案 |
| P1 | 复杂 DAG 自动化设计器 | L | V1 仅线性链，需分支/并行 |
| P1 | 高级 BI 分析 | L | V1 仅基础聚合 |

建议在 Phase 2 启动前进行 CRDT 技术选型（Yjs / Automerge / 自研），预计需要 1 周调研。
