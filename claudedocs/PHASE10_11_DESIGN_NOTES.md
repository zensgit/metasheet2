# Phase 10/11 综合设计笔记

**文档版本**: 1.0.0
**创建日期**: 2025-11-16
**状态**: 规划中

---

## 📋 概述

基于 Phase 6-9 完成的基础，本文档从三个维度规划下一阶段：

1. **产品能力** - 功能增强与用户价值
2. **可靠性** - 生产级质量与故障恢复
3. **团队效率** - 开发体验与运维自动化

---

## 🎯 优先级矩阵

| 优先级 | 方向 | 预期收益 | 实现复杂度 | 建议 Sprint |
|--------|------|----------|------------|-------------|
| **P0** | 开发环境一键启动 | 高 | 低 | Sprint 1 |
| **P0** | 本地观测环境标准化 | 高 | 低 | Sprint 1 |
| **P0** | 安全护栏 (double-confirm) | 极高 | 中 | Sprint 1 |
| **P1** | Snapshot 标签与保护规则 | 高 | 中 | Sprint 2 |
| **P1** | 插件健康监控仪表板 | 高 | 中 | Sprint 2 |
| **P1** | SLO + Error Budget | 极高 | 中 | Sprint 2 |
| **P2** | DLQ 运维管理接口 | 中 | 中 | Sprint 3 |
| **P2** | 变更自动摘要生成 | 中 | 低 | Sprint 3 |
| **P3** | 金丝雀发布流程 | 高 | 高 | 未来 |

---

## Sprint 1: 团队效率 + 安全护栏 (建议 3-5 天)

### 1.1 开发环境一键启动

```bash
# scripts/dev-bootstrap.sh
#!/bin/bash
set -e

echo "🚀 Starting MetaSheet V2 Development Environment..."

# 1. 检查依赖
command -v docker >/dev/null 2>&1 || { echo "❌ Docker required"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "❌ Node.js required"; exit 1; }

# 2. 启动数据库
docker-compose -f docker/dev-postgres.yml up -d

# 3. 等待数据库就绪
echo "⏳ Waiting for PostgreSQL..."
until docker exec metasheet-postgres pg_isready; do sleep 1; done

# 4. 运行迁移
pnpm --filter @metasheet/core-backend db:migrate

# 5. Seed 测试数据
pnpm --filter @metasheet/core-backend db:seed

# 6. 启动核心服务
pnpm --filter @metasheet/core-backend dev

echo "✅ Development environment ready!"
echo "📊 Metrics: http://localhost:4000/metrics"
echo "🔧 API: http://localhost:4000/api"
```

**交付物**:
- `scripts/dev-bootstrap.sh`
- `docker/dev-postgres.yml`
- `README.md` 更新开发环境说明

---

### 1.2 本地观测环境标准化

```yaml
# docker/observability/docker-compose.yml
version: '3.8'
services:
  prometheus:
    image: prom/prometheus:latest
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml

  grafana:
    image: grafana/grafana:latest
    ports:
      - "3000:3000"
    volumes:
      - ./dashboards:/etc/grafana/provisioning/dashboards
      - ./datasources:/etc/grafana/provisioning/datasources
```

**预置 Dashboard**:
- `dashboards/metasheet-overview.json` - 核心指标概览
- `dashboards/snapshot-operations.json` - Snapshot SLO 面板
- `dashboards/plugin-health.json` - 插件健康监控

**交付物**:
- `docker/observability/docker-compose.yml`
- `docker/observability/prometheus.yml`
- `docker/observability/dashboards/*.json`
- 10 分钟快速启动文档

---

### 1.3 安全护栏 (Critical Operations)

```typescript
// src/guards/SafetyGuard.ts

interface DangerousOperationConfig {
  operation: string
  requiresReason: boolean
  doubleConfirm: boolean
  notifyChannels: string[]
  minApprovers?: number
}

const DANGEROUS_OPERATIONS: DangerousOperationConfig[] = [
  {
    operation: 'snapshot.restore_production',
    requiresReason: true,
    doubleConfirm: true,
    notifyChannels: ['slack', 'email'],
    minApprovers: 2
  },
  {
    operation: 'snapshot.bulk_delete',
    requiresReason: true,
    doubleConfirm: true,
    notifyChannels: ['slack']
  },
  {
    operation: 'plugin.disable_core',
    requiresReason: true,
    doubleConfirm: true,
    notifyChannels: ['slack', 'pagerduty']
  },
  {
    operation: 'schema.destructive_migration',
    requiresReason: true,
    doubleConfirm: true,
    notifyChannels: ['slack', 'email'],
    minApprovers: 1
  }
]

class SafetyGuard {
  async validateDangerousOperation(
    operation: string,
    params: {
      userId: string
      reason?: string
      confirmationToken?: string
      environment: 'dev' | 'staging' | 'production'
    }
  ): Promise<{ allowed: boolean; warnings: string[] }> {
    const config = DANGEROUS_OPERATIONS.find(op => op.operation === operation)

    if (!config) {
      return { allowed: true, warnings: [] }
    }

    const warnings: string[] = []

    // 生产环境强制检查
    if (params.environment === 'production') {
      if (config.requiresReason && !params.reason) {
        return {
          allowed: false,
          warnings: ['REASON_REQUIRED: 生产环境操作必须提供理由']
        }
      }

      if (config.doubleConfirm && !params.confirmationToken) {
        return {
          allowed: false,
          warnings: ['DOUBLE_CONFIRM_REQUIRED: 请先调用 /api/confirm 获取确认令牌']
        }
      }

      warnings.push('⚠️ PRODUCTION_OPERATION: 此操作将影响生产环境')
    }

    // 发送通知
    await this.notifyChannels(config.notifyChannels, {
      operation,
      userId: params.userId,
      reason: params.reason,
      environment: params.environment,
      timestamp: new Date()
    })

    // 记录审计日志
    await this.auditLog(operation, params)

    return { allowed: true, warnings }
  }

  async requestConfirmationToken(operation: string, userId: string): Promise<string> {
    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = Date.now() + 5 * 60 * 1000 // 5 分钟有效

    await cache.set(`confirm:${token}`, {
      operation,
      userId,
      expiresAt
    }, { ttl: 300 })

    return token
  }
}
```

**API 端点**:
```typescript
// POST /api/admin/confirm
// 获取危险操作确认令牌

// POST /api/snapshots/:id/restore (增强)
// Body: { reason: string, confirmation_token: string }
```

**新增指标**:
```typescript
const dangerousOperationsTotal = new Counter({
  name: 'metasheet_dangerous_operations_total',
  help: 'Total dangerous operations executed',
  labelNames: ['operation', 'environment', 'result']
})

const operationBlockedTotal = new Counter({
  name: 'metasheet_operation_blocked_total',
  help: 'Operations blocked by safety guard',
  labelNames: ['operation', 'reason']
})
```

**交付物**:
- `src/guards/SafetyGuard.ts`
- `src/routes/admin/confirm.ts`
- 危险操作配置表
- 审计日志表迁移

---

## Sprint 2: 产品能力增强 (建议 5-7 天)

### 2.1 Snapshot 标签与保护规则

```sql
-- migrations/add_snapshot_tags.sql
ALTER TABLE snapshots
ADD COLUMN tags TEXT[] DEFAULT '{}',
ADD COLUMN protection_level TEXT DEFAULT 'normal';
-- normal, protected, critical

CREATE INDEX idx_snapshots_tags ON snapshots USING GIN(tags);
CREATE INDEX idx_snapshots_protection ON snapshots(protection_level);

-- 保护规则表
CREATE TABLE snapshot_protection_rules (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  rule_name TEXT NOT NULL UNIQUE,
  conditions JSONB NOT NULL, -- 匹配条件
  protection_level TEXT NOT NULL,
  auto_apply BOOLEAN DEFAULT false,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**预定义标签**:
```typescript
enum SnapshotTag {
  STABLE = 'stable',
  CANARY = 'canary',
  PRE_RELEASE = 'pre-release',
  ROLLBACK_TARGET = 'rollback-target',
  AUTO_GENERATED = 'auto-generated',
  SCHEMA_CHANGE = 'schema-change',
  CRITICAL = 'critical'
}
```

**保护规则示例**:
```json
{
  "rule_name": "protect_schema_snapshots",
  "conditions": {
    "tags_contain": ["schema-change"],
    "age_less_than_days": 30
  },
  "protection_level": "protected",
  "auto_apply": true
}
```

**API 增强**:
```typescript
// PATCH /api/snapshots/:id/tags
// Body: { add_tags: string[], remove_tags: string[] }

// GET /api/snapshots?tag=stable
// 按标签过滤

// POST /api/snapshots/:id/set-protection
// Body: { level: 'normal' | 'protected' | 'critical', reason: string }

// GET /api/snapshots/latest?tag=stable
// 获取最近的稳定版本
```

**一键回滚操作**:
```typescript
// POST /api/views/:viewId/rollback-to-stable
// 自动找到最近的 stable 标签快照并恢复
```

---

### 2.2 插件健康监控

```typescript
// src/services/PluginHealthService.ts

interface PluginHealthReport {
  pluginName: string
  status: 'healthy' | 'degraded' | 'unhealthy'
  metrics: {
    loadSuccessRate: number      // 过去 24 小时
    avgProcessingTime: number    // 毫秒
    errorCount: number           // 过去 1 小时
    reloadCount: number          // 过去 24 小时
    lastActiveAt: Date
  }
  dependencies: string[]
  warnings: string[]
}

class PluginHealthService {
  async getHealthReport(pluginName: string): Promise<PluginHealthReport> {
    const metrics = await this.collectPluginMetrics(pluginName)

    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy'
    const warnings: string[] = []

    // 健康判定规则
    if (metrics.loadSuccessRate < 0.95) {
      status = 'degraded'
      warnings.push('Load success rate below 95%')
    }

    if (metrics.errorCount > 10) {
      status = 'degraded'
      warnings.push('High error count in last hour')
    }

    if (metrics.loadSuccessRate < 0.80 || metrics.errorCount > 50) {
      status = 'unhealthy'
    }

    return {
      pluginName,
      status,
      metrics,
      dependencies: await this.getPluginDependencies(pluginName),
      warnings
    }
  }

  async getAllPluginsHealth(): Promise<PluginHealthReport[]> {
    const plugins = await this.listActivePlugins()
    return Promise.all(plugins.map(p => this.getHealthReport(p.name)))
  }

  async getDependencyGraph(): Promise<DependencyGraph> {
    // 返回插件依赖可视化数据
  }
}
```

**新增指标**:
```typescript
const pluginHealthGauge = new Gauge({
  name: 'metasheet_plugin_health',
  help: 'Plugin health status (1=healthy, 0.5=degraded, 0=unhealthy)',
  labelNames: ['plugin_name']
})

const pluginProcessingDuration = new Histogram({
  name: 'metasheet_plugin_processing_seconds',
  help: 'Plugin message processing duration',
  labelNames: ['plugin_name'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5]
})
```

---

### 2.3 SLO + Error Budget

```typescript
// src/slo/SLOManager.ts

interface SLODefinition {
  name: string
  target: number           // 例如 0.99 = 99%
  window: '7d' | '30d'
  indicator: {
    type: 'availability' | 'latency' | 'error_rate'
    query: string          // PromQL
    threshold?: number     // 用于 latency SLO
  }
}

const SLO_DEFINITIONS: SLODefinition[] = [
  {
    name: 'snapshot_create_availability',
    target: 0.99,
    window: '7d',
    indicator: {
      type: 'availability',
      query: 'rate(metasheet_snapshot_create_total{result="success"}[7d]) / rate(metasheet_snapshot_create_total[7d])'
    }
  },
  {
    name: 'snapshot_restore_availability',
    target: 0.995,
    window: '7d',
    indicator: {
      type: 'availability',
      query: 'rate(metasheet_snapshot_restore_total{result="success"}[7d]) / rate(metasheet_snapshot_restore_total[7d])'
    }
  },
  {
    name: 'plugin_reload_availability',
    target: 0.95,
    window: '7d',
    indicator: {
      type: 'availability',
      query: 'rate(metasheet_plugin_reload_total{result="success"}[7d]) / rate(metasheet_plugin_reload_total[7d])'
    }
  },
  {
    name: 'http_p99_latency',
    target: 0.99,
    window: '7d',
    indicator: {
      type: 'latency',
      query: 'histogram_quantile(0.99, rate(http_server_requests_seconds_bucket[5m]))',
      threshold: 2 // 秒
    }
  }
]

class SLOManager {
  async getErrorBudget(sloName: string): Promise<{
    slo: SLODefinition
    current: number
    remaining: number
    burnRate: number
    status: 'ok' | 'warning' | 'critical'
  }> {
    const slo = SLO_DEFINITIONS.find(s => s.name === sloName)
    if (!slo) throw new Error('SLO not found')

    const current = await this.queryCurrentValue(slo.indicator.query)
    const errorBudget = 1 - slo.target  // 例如 1% for 99% SLO
    const consumed = slo.target - current
    const remaining = Math.max(0, errorBudget - consumed)
    const burnRate = consumed / errorBudget

    let status: 'ok' | 'warning' | 'critical' = 'ok'
    if (remaining < errorBudget * 0.3) status = 'warning'
    if (remaining < errorBudget * 0.1) status = 'critical'

    return { slo, current, remaining, burnRate, status }
  }

  async checkAllSLOs(): Promise<SLOStatus[]> {
    return Promise.all(SLO_DEFINITIONS.map(slo => this.getErrorBudget(slo.name)))
  }

  async triggerProtectiveAction(sloName: string): Promise<void> {
    // 当 Error Budget 消耗过快时，触发保护动作
    // 例如：冻结高风险操作、降低非核心任务优先级
  }
}
```

**Grafana SLO 面板**:
```json
{
  "title": "SLO Error Budget Dashboard",
  "panels": [
    {
      "title": "Snapshot Create SLO (99%)",
      "type": "gauge",
      "targets": [{ "expr": "slo:snapshot_create:current" }]
    },
    {
      "title": "Error Budget Burn Rate",
      "type": "timeseries",
      "targets": [{ "expr": "slo:error_budget_burn_rate" }]
    }
  ]
}
```

---

## Sprint 3: Phase 10/11 核心实现

### 3.1 Advanced Messaging - 独立上线切片

**切片 1: 延迟投递 (10.1)**
```typescript
// 最小实现：基于内存 + 定时器
class SimpleDelayScheduler {
  private queue: Map<string, NodeJS.Timeout> = new Map()

  schedule(message: any, delayMs: number): string {
    const id = generateId()
    const timer = setTimeout(() => {
      messageBus.publish(message.topic, message.payload)
      this.queue.delete(id)
    }, delayMs)

    this.queue.set(id, timer)
    return id
  }

  cancel(id: string): boolean {
    const timer = this.queue.get(id)
    if (timer) {
      clearTimeout(timer)
      this.queue.delete(id)
      return true
    }
    return false
  }
}
```

**切片 2: DLQ + 简单重试 (10.2)**
```sql
CREATE TABLE dead_letter_queue (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  payload JSONB NOT NULL,
  error_type TEXT NOT NULL,
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  first_failed_at TIMESTAMPTZ NOT NULL,
  last_failed_at TIMESTAMPTZ NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**切片 3: 可配置退避 (10.3)**
- 见 PHASE10_ADVANCED_MESSAGING_PLAN.md 详细设计

---

### 3.2 Performance & Scale - 渐进优化

**阶段 1: 基准测试 (11.0)**
```bash
# scripts/perf-baseline.sh
#!/bin/bash
echo "📊 Running Performance Baseline Tests..."

# Event Bus 性能
node scripts/bench-event-bus.js --subscribers 100 --events 10000

# Snapshot 操作性能
node scripts/bench-snapshot.js --items 1000

# 插件重载性能
node scripts/bench-plugin-reload.js --iterations 50

echo "📈 Results saved to perf-results/"
```

**阶段 2: 模式索引 (11.1)**
- 当订阅量 > 100 时，从 linear scan 切换到 Trie
- 见 PHASE11_PERFORMANCE_SCALE_PLAN.md 详细设计

**阶段 3: LRU 缓存 (11.2)**
- 热点模式缓存
- 自动失效策略

---

## 文档与代码映射索引

```markdown
# docs/MAP_FEATURE_TO_CODE.md

## Snapshot/Versioning
- **数据库迁移**: `migrations/20250116_*_snapshot*.sql`
- **核心服务**: `src/services/SnapshotService.ts`
- **API 路由**: `src/routes/snapshots.ts`
- **指标**: `src/metrics/metrics.ts` (snapshotCreateTotal, snapshotRestoreTotal, snapshotCleanupTotal)
- **类型定义**: `src/types/snapshot.ts`

## Plugin Reload
- **核心实现**: `src/plugin/PluginLoader.ts:reloadPlugin()`
- **HTTP 端点**: `src/routes/admin/plugins.ts`
- **指标**: pluginReloadTotal, pluginReloadDuration
- **测试**: `test/plugin-reload.test.ts`

## Event Bus
- **核心实现**: `src/integration/EventBus.ts`
- **模式匹配**: `src/integration/PatternMatcher.ts`
- **指标**: eventsEmittedTotal
- **订阅管理**: `EventBus.subscribe()`, `EventBus.unsubscribe()`

## Message Bus
- **核心实现**: `src/integration/MessageBus.ts`
- **RPC 支持**: `MessageBus.rpc()`, `MessageBus.registerRpcHandler()`
- **指标**: messagesProcessedTotal, messagesRetriedTotal, rpcTimeoutsTotal
- **配置**: `src/config/messaging.ts`

## RBAC & Permissions
- **权限检查**: `src/rbac/rbac.ts`
- **权限指标**: `src/rbac/PermissionMetrics.ts`
- **守卫中间件**: `rbacGuard()`
- **指标**: permissionDeniedTotal, rbacDenials

## Observability
- **指标注册**: `src/metrics/metrics.ts`
- **中间件**: `requestMetricsMiddleware()`
- **端点**: `/metrics` (JSON), `/metrics/prom` (Prometheus)
- **配置**: 见 PHASE5_OBSERVATION_CONFIG.md
```

---

## 验收标准

### Sprint 1 验收
- [ ] `scripts/dev-bootstrap.sh` 一键启动成功
- [ ] 本地 Prometheus + Grafana 10 分钟内可用
- [ ] 危险操作需要 reason + confirmation_token
- [ ] 审计日志记录所有危险操作

### Sprint 2 验收
- [ ] Snapshot 支持 tags 和 protection_level
- [ ] 一键回滚到最近 stable 快照
- [ ] 插件健康报告 API 可用
- [ ] SLO Dashboard 显示 Error Budget

### Sprint 3 验收
- [ ] 延迟消息可正常调度
- [ ] 失败消息进入 DLQ
- [ ] 性能基准测试脚本可执行

---

## 下一步建议

1. **立即执行** (Sprint 1):
   - 创建 `scripts/dev-bootstrap.sh`
   - 配置本地观测环境
   - 实现 SafetyGuard

2. **短期规划** (Sprint 2):
   - Snapshot 标签系统
   - 插件健康监控
   - SLO 管理器

3. **中期规划** (Sprint 3):
   - Phase 10 切片实现
   - 性能基准测试

---

## 🔬 Sprint 1 验证方案

### 完成判定标准

#### 1.1 开发环境一键启动 (dev-bootstrap.sh)

**成功标准**:
- [ ] 新人在全新 macOS/Linux 环境 **30 分钟内**能跑起完整开发环境
- [ ] 记录成功率目标: **≥ 90%** (首次尝试成功)
- [ ] 脚本自动检测并报告缺失依赖
- [ ] 提供回滚/清理脚本 `scripts/dev-cleanup.sh`

**验证步骤**:
```bash
# 1. 克隆新仓库
git clone ... && cd metasheet-v2

# 2. 运行一键启动
./scripts/dev-bootstrap.sh

# 3. 验证检查清单
curl http://localhost:4000/health      # ✅ 返回 OK
curl http://localhost:4000/metrics     # ✅ 返回指标
psql -h localhost -U metasheet -c "SELECT 1"  # ✅ DB 可访问

# 4. 记录完成时间
echo "Setup completed in $(time) minutes"
```

**文档交付**:
- README.md 中新增 "Quick Start" 章节
- 包含截图: 终端输出示例、服务启动成功界面
- 常见问题排查 FAQ (至少 5 个)

---

#### 1.2 本地观测环境标准化

**成功标准**:
- [ ] **10 分钟内**从零到看到 Grafana Dashboard
- [ ] 提供 3 个预置 Dashboard JSON:
  - `metasheet-overview.json` - 核心指标概览
  - `snapshot-operations.json` - Snapshot SLO 面板
  - `plugin-health.json` - 插件健康监控
- [ ] README 包含"步骤 + 截图参考"

**验证步骤**:
```bash
# 1. 启动观测环境
cd docker/observability
docker-compose up -d

# 2. 验证服务
curl http://localhost:9090/-/ready   # Prometheus 就绪
curl http://localhost:3000/api/health  # Grafana 就绪

# 3. 导入 Dashboard
# 浏览器打开 http://localhost:3000
# 使用默认账号 admin/admin 登录
# 检查预置 Dashboard 是否自动加载
```

**文档交付**:
- docker/observability/README.md - 快速启动指南
- docker/observability/screenshots/ - 各 Dashboard 截图
- 指标含义说明表

---

#### 1.3 SafetyGuard 安全护栏

**成功标准**:
- [ ] 覆盖 **至少 3 类危险操作**:
  1. 生产环境 Snapshot 恢复
  2. 插件重载/禁用核心插件
  3. 批量删除操作
- [ ] 每类操作有 **自动化测试** 覆盖
- [ ] 拦截率: **100%** (无漏网之鱼)

**验证步骤**:
```bash
# 1. 运行 SafetyGuard 测试套件
pnpm test:safety-guard

# 2. 手动测试危险操作
# 尝试恢复生产快照 (无 reason)
curl -X POST http://localhost:4000/api/snapshots/xxx/restore \
  -H "Content-Type: application/json" \
  -d '{"environment": "production"}'
# 预期: 400 BAD_REQUEST, message: "REASON_REQUIRED"

# 3. 检查审计日志
psql -c "SELECT * FROM audit_logs WHERE operation LIKE 'dangerous_%'"
```

**测试覆盖**:
```typescript
// test/safety-guard.test.ts
describe('SafetyGuard', () => {
  it('blocks production snapshot restore without reason', async () => {
    const result = await safetyGuard.validateDangerousOperation(
      'snapshot.restore_production',
      { userId: 'user1', environment: 'production' }
    )
    expect(result.allowed).toBe(false)
    expect(result.warnings).toContain('REASON_REQUIRED')
  })

  it('blocks plugin disable without confirmation', async () => { ... })
  it('blocks bulk delete without double-confirm', async () => { ... })
  it('allows operation with valid token and reason', async () => { ... })
})
```

**指标验证**:
- `metasheet_dangerous_operations_total` 正确计数
- `metasheet_operation_blocked_total` 正确分类

---

### Sprint 1 定量指标

| 指标 | 目标值 | 测量方法 |
|------|--------|----------|
| 新人启动成功率 | ≥ 90% | 内部测试 3+ 人 |
| 启动时间 | ≤ 30 分钟 | 计时记录 |
| 观测环境启动 | ≤ 10 分钟 | 计时记录 |
| SafetyGuard 测试覆盖 | ≥ 95% | jest coverage |
| 危险操作拦截率 | 100% | 手动 + 自动测试 |
| 文档完整性 | 100% | 检查清单验证 |

---

## 🧪 Pilot Use Cases (Sprint 4 前验证)

在正式投入 Phase 10/11 大量开发前，选择 1-2 个试点场景来反向验证设计：

### 试点 1: 延迟消息 - 快照过期提醒

**场景描述**:
当快照设置了过期时间时，提前 24 小时发送提醒消息。

**当前痛点**:
- 无法在未来某个时间点自动触发操作
- 依赖外部定时器或 cron job

**验证目标**:
- 延迟投递是否满足 ±1 秒精度？
- 内存实现 vs Redis 实现的取舍？
- 重启后消息是否丢失？

**最小实现**:
```typescript
// 创建快照时注册提醒
async createSnapshot(input) {
  const snapshot = await this.saveSnapshot(input)

  if (input.expiresAt) {
    const reminderTime = input.expiresAt.getTime() - 24 * 3600 * 1000
    await messageBus.publishDelayed('snapshot.expiry_reminder', {
      snapshotId: snapshot.id,
      expiresAt: input.expiresAt
    }, {
      delayMs: reminderTime - Date.now()
    })
  }

  return snapshot
}
```

**决策点**:
- 简单场景用内存定时器即可，无需 Redis
- 如果重启丢失可接受，则内存方案足够
- 如果不可接受，需要持久化 → 考虑 DB 轮询方案

---

### 试点 2: 事件匹配性能 - 插件订阅扩展

**场景描述**:
系统有 50+ 插件，每个插件订阅 10+ 个事件模式，总计 500+ 订阅。

**当前痛点**:
- Linear scan O(n) 随订阅数增长
- 高频事件触发时延迟明显

**验证目标**:
- 当前性能瓶颈在哪？(基准测试)
- Trie vs 桶分片哪个更适合？
- 优化收益是否值得复杂度？

**基准测试脚本**:
```bash
# scripts/bench-pattern-matching.sh
#!/bin/bash

echo "📊 Pattern Matching Performance Benchmark"

# 场景 1: 100 订阅
node scripts/bench-event-bus.js --subscribers 100 --events 10000

# 场景 2: 500 订阅
node scripts/bench-event-bus.js --subscribers 500 --events 10000

# 场景 3: 1000 订阅
node scripts/bench-event-bus.js --subscribers 1000 --events 10000

# 生成报告
echo "Results saved to perf-results/pattern-matching-$(date +%Y%m%d).json"
```

**决策点**:
- 如果 500 订阅下 P99 < 10ms，可能无需优化
- 如果 > 50ms，Trie 优化有价值
- 根据实际使用模式决定优化方向

---

### 试点验证清单

| 试点场景 | 验证问题 | 预期结果 | 实际结果 | 决策 |
|----------|----------|----------|----------|------|
| 延迟消息 | 精度是否足够？ | ±1 秒 | (待测) | 内存/Redis |
| 延迟消息 | 重启丢失可接受？ | 是/否 | (待测) | 持久化策略 |
| 模式匹配 | 当前性能瓶颈？ | P99 > 50ms | (待测) | 是否优化 |
| 模式匹配 | 500 订阅表现？ | - | (待测) | 优化方案 |

---

### 试点执行计划

**Week 1**:
- 创建基准测试脚本
- 运行当前性能测试
- 记录基线数据

**Week 2**:
- 实现最小延迟消息功能
- 在试点场景中验证
- 收集反馈和问题

**Week 3**:
- 分析试点结果
- 调整 Phase 10/11 设计
- 更新优先级和复杂度估算

---

## 📊 功能状态追踪

为防止"文档超前于代码/代码超前于文档"，使用以下状态标签：

| 状态 | 含义 | 符号 |
|------|------|------|
| **Design Only** | 仅有设计文档 | 📐 |
| **In Progress** | 正在实现 | 🔨 |
| **Implemented** | 已实现，待验证 | ✅ |
| **Verified** | 已验证，生产就绪 | 🚀 |

### Sprint 1 功能状态

| 功能 | 文档 | 代码 | 状态 |
|------|------|------|------|
| dev-bootstrap.sh | PHASE10_11_DESIGN_NOTES.md | - | 📐 Design Only |
| 本地观测环境 | PHASE10_11_DESIGN_NOTES.md | - | 📐 Design Only |
| SafetyGuard | PHASE10_11_DESIGN_NOTES.md | - | 📐 Design Only |

### Sprint 2 功能状态

| 功能 | 文档 | 代码 | 状态 |
|------|------|------|------|
| Snapshot 标签 | CHANGE_MANAGEMENT_*.md | - | 📐 Design Only |
| 保护规则 | CHANGE_MANAGEMENT_*.md | - | 📐 Design Only |
| 插件健康监控 | PHASE10_11_DESIGN_NOTES.md | - | 📐 Design Only |
| SLO Manager | PHASE10_11_DESIGN_NOTES.md | - | 📐 Design Only |

### Sprint 3 功能状态

| 功能 | 文档 | 代码 | 状态 |
|------|------|------|------|
| ChangeManagementService | CHANGE_MANAGEMENT_*.md | - | 📐 Design Only |
| 变更审批流程 | CHANGE_MANAGEMENT_*.md | - | 📐 Design Only |
| Schema 快照 | CHANGE_MANAGEMENT_*.md | - | 📐 Design Only |

---

**🤖 Generated with [Claude Code](https://claude.com/claude-code)**
