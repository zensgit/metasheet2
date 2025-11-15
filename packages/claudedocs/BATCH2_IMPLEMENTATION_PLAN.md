# Batch 2 实施计划 - OpenTelemetry & Cache Phase 1

**创建日期**: 2025-11-03
**状态**: 📋 规划中
**优先级**: 🟢 P1 (中低风险基础设施)

---

## 📋 执行摘要

Batch 2 包含两个并行任务，都是**基础设施级别**的改进，默认禁用，对现有业务无影响：

1. **plugin-telemetry-otel** - OpenTelemetry 可观测性插件
2. **Cache Phase 1** - 缓存注册中心 + NullCache 实现

**预计时间**: 2-3 天
**风险等级**: 🟢 低（默认禁用，纯增量）
**依赖关系**: 无（两个任务可并行）

---

## 🎯 任务 1: plugin-telemetry-otel

### 1.1 目标

创建 MetaSheet V2 的 OpenTelemetry 插件，提供**最小可用**的 metrics + tracing 装配。

**核心原则**:
- ✅ **默认禁用** - `FEATURE_OTEL=false`
- ✅ **最小骨架** - 不求完美，先跑通
- ✅ **插件隔离** - 不污染核心代码
- ✅ **Prometheus 导出** - 标准监控栈集成

### 1.2 技术架构

#### 目录结构
```
plugins/plugin-telemetry-otel/
├── plugin.json                 # 插件元数据
├── package.json                # 依赖配置
├── vite.config.ts              # 构建配置
├── README.md                   # 使用文档
├── src/
│   ├── index.ts                # 插件入口
│   ├── config.ts               # OTel 配置
│   ├── metrics/
│   │   ├── index.ts            # Metrics 装配
│   │   ├── collectors/
│   │   │   ├── http.ts         # HTTP 请求指标
│   │   │   └── system.ts       # 系统资源指标
│   │   └── registry.ts         # Prometheus Registry
│   ├── tracing/
│   │   ├── index.ts            # Tracing 装配
│   │   ├── span-processor.ts  # Span 处理器
│   │   └── context.ts          # Context 传播
│   └── exporters/
│       └── prometheus.ts       # Prometheus 导出器
└── tests/
    └── smoke.test.ts           # 基础 smoke 测试
```

#### 依赖包
```json
{
  "@opentelemetry/api": "^1.9.0",
  "@opentelemetry/sdk-node": "^0.52.0",
  "@opentelemetry/instrumentation-http": "^0.52.0",
  "@opentelemetry/exporter-prometheus": "^0.52.0",
  "@opentelemetry/exporter-trace-otlp-http": "^0.52.0"
}
```

### 1.3 最小功能范围

#### Phase 1 (本次实现)
- ✅ HTTP 请求 metrics (请求数、延迟、错误率)
- ✅ 系统资源 metrics (CPU、内存)
- ✅ 基础 tracing (HTTP 请求追踪)
- ✅ Prometheus `/metrics` 端点
- ✅ 功能开关 `FEATURE_OTEL`
- ✅ 1 个 smoke test

#### Phase 2 (未来扩展)
- ⏸️ 数据库查询 tracing
- ⏸️ Redis/Cache 操作 metrics
- ⏸️ 自定义业务 metrics
- ⏸️ Jaeger/Zipkin 导出
- ⏸️ 分布式追踪 context 传播

### 1.4 plugin.json 配置

```json
{
  "name": "plugin-telemetry-otel",
  "version": "1.0.0",
  "displayName": "OpenTelemetry 可观测性",
  "description": "提供 Metrics 和 Tracing 功能的 OpenTelemetry 插件",
  "type": "service",
  "main": {
    "backend": "dist/index.js"
  },
  "contributes": {
    "services": [
      {
        "id": "telemetry-otel",
        "name": "OpenTelemetry 服务",
        "description": "提供系统级别的 Metrics 和 Tracing"
      }
    ],
    "apiRoutes": [
      {
        "method": "GET",
        "path": "/metrics",
        "description": "Prometheus metrics 导出端点"
      }
    ]
  },
  "permissions": [
    "system.metrics",
    "system.tracing",
    "http.intercept",
    "api.register"
  ],
  "engines": {
    "metasheet": ">=2.0.0"
  },
  "config": {
    "enabled": {
      "type": "boolean",
      "default": false,
      "description": "是否启用 OpenTelemetry (FEATURE_OTEL)"
    },
    "metricsPort": {
      "type": "number",
      "default": 9464,
      "description": "Prometheus metrics 导出端口"
    },
    "serviceName": {
      "type": "string",
      "default": "metasheet-v2",
      "description": "服务名称（用于 tracing）"
    },
    "tracingSampleRate": {
      "type": "number",
      "default": 0.1,
      "description": "Tracing 采样率 (0.0-1.0)"
    }
  }
}
```

### 1.5 核心实现代码片段

#### src/index.ts (插件入口)
```typescript
import { Plugin, PluginContext } from '@metasheet/plugin-system'
import { setupMetrics } from './metrics'
import { setupTracing } from './tracing'
import { setupPrometheusExporter } from './exporters/prometheus'

export default class TelemetryOtelPlugin implements Plugin {
  private enabled: boolean = false

  async onLoad(context: PluginContext): Promise<void> {
    // 检查功能开关
    this.enabled = process.env.FEATURE_OTEL === 'true'

    if (!this.enabled) {
      context.logger.info('OpenTelemetry plugin is disabled (FEATURE_OTEL=false)')
      return
    }

    context.logger.info('Initializing OpenTelemetry plugin...')

    // 初始化 Metrics
    await setupMetrics(context)

    // 初始化 Tracing
    await setupTracing(context)

    // 启动 Prometheus 导出器
    await setupPrometheusExporter(context)

    context.logger.info('OpenTelemetry plugin initialized successfully')
  }

  async onUnload(): Promise<void> {
    // 清理资源
  }
}
```

#### src/metrics/collectors/http.ts
```typescript
import { Counter, Histogram } from '@opentelemetry/api'

export function createHttpMetrics(meter: any) {
  const httpRequestsTotal = meter.createCounter('http_requests_total', {
    description: 'Total HTTP requests'
  })

  const httpRequestDuration = meter.createHistogram('http_request_duration_seconds', {
    description: 'HTTP request duration in seconds'
  })

  const httpRequestErrors = meter.createCounter('http_request_errors_total', {
    description: 'Total HTTP request errors'
  })

  return {
    httpRequestsTotal,
    httpRequestDuration,
    httpRequestErrors
  }
}
```

### 1.6 Smoke Test

```typescript
// tests/smoke.test.ts
import { describe, it, expect } from 'vitest'
import TelemetryOtelPlugin from '../src'

describe('plugin-telemetry-otel smoke test', () => {
  it('should load plugin with FEATURE_OTEL=false', async () => {
    process.env.FEATURE_OTEL = 'false'

    const plugin = new TelemetryOtelPlugin()
    const mockContext = {
      logger: {
        info: (msg: string) => {},
        warn: (msg: string) => {},
        error: (msg: string) => {}
      }
    }

    await plugin.onLoad(mockContext as any)

    // 插件应该正常加载但不初始化
    expect(true).toBe(true)
  })

  it('should expose Prometheus metrics endpoint when enabled', async () => {
    process.env.FEATURE_OTEL = 'true'

    // TODO: 实际测试 /metrics 端点
    expect(true).toBe(true)
  })
})
```

### 1.7 README.md 内容大纲

```markdown
# plugin-telemetry-otel

OpenTelemetry 可观测性插件 - 提供 Metrics 和 Tracing 功能

## 快速开始

### 启用插件
```bash
export FEATURE_OTEL=true
pnpm dev
```

### 访问 Metrics
```bash
curl http://localhost:9464/metrics
```

## 配置

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| FEATURE_OTEL | false | 是否启用 OpenTelemetry |
| OTEL_METRICS_PORT | 9464 | Prometheus 导出端口 |
| OTEL_SERVICE_NAME | metasheet-v2 | 服务名称 |
| OTEL_TRACE_SAMPLE_RATE | 0.1 | Tracing 采样率 |

## Metrics 列表

- `http_requests_total` - HTTP 请求总数
- `http_request_duration_seconds` - HTTP 请求延迟
- `http_request_errors_total` - HTTP 错误总数
- `process_cpu_usage` - CPU 使用率
- `process_memory_usage_bytes` - 内存使用

## 与 Prometheus 集成

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'metasheet-v2'
    static_configs:
      - targets: ['localhost:9464']
```

## 开发指南

### 添加自定义 Metric
[示例代码]

### 添加 Span 属性
[示例代码]
```

### 1.8 实施步骤

1. **创建分支** (5 分钟)
   ```bash
   git checkout -b feat/plugin-telemetry-otel
   ```

2. **创建插件目录** (10 分钟)
   ```bash
   mkdir -p plugins/plugin-telemetry-otel/{src/{metrics/collectors,tracing,exporters},tests}
   ```

3. **配置文件** (30 分钟)
   - plugin.json
   - package.json
   - vite.config.ts (复制 plugin-audit-logger 的配置)

4. **实现核心功能** (3-4 小时)
   - src/index.ts (插件入口)
   - src/config.ts (配置管理)
   - src/metrics/index.ts (Metrics 装配)
   - src/metrics/collectors/http.ts (HTTP metrics)
   - src/metrics/collectors/system.ts (系统 metrics)
   - src/exporters/prometheus.ts (Prometheus 导出)
   - src/tracing/index.ts (Tracing 装配 - 最小实现)

5. **测试** (1 小时)
   - tests/smoke.test.ts
   - 手动测试 /metrics 端点

6. **文档** (30 分钟)
   - README.md

7. **构建和验证** (30 分钟)
   ```bash
   pnpm install
   pnpm build
   FEATURE_OTEL=true pnpm dev
   curl http://localhost:9464/metrics
   ```

**预计总时间**: 6-7 小时

---

## 🎯 任务 2: Cache Phase 1 - Registry + NullCache

### 2.1 目标

建立缓存系统的**观测基础设施**，而不立即改变业务路由。

**核心原则**:
- ✅ **观测优先** - 先观测，后优化
- ✅ **不改业务** - 不修改现有路由代码
- ✅ **可切换** - 通过配置切换缓存实现
- ✅ **指标完备** - 所有操作都有 metrics

### 2.2 技术架构

#### 目录结构
```
packages/core-backend/src/
├── cache/
│   ├── index.ts                # 导出
│   ├── registry.ts             # CacheRegistry (核心)
│   ├── implementations/
│   │   └── null-cache.ts       # NullCache 实现
│   ├── metrics.ts              # 缓存指标收集器
│   └── types.ts                # 类型定义 (复用 types/cache.ts)
└── types/
    └── cache.ts                # Cache 接口 (已存在)
```

### 2.3 核心组件设计

#### 2.3.1 CacheRegistry (注册中心)

**职责**:
- 管理多个 Cache 实现的注册
- 提供统一的缓存访问接口
- 收集缓存操作指标
- 支持热切换缓存实现

**代码示例**:
```typescript
// src/cache/registry.ts
import { Cache, Result } from '../types/cache'
import { cacheMetrics } from './metrics'

export class CacheRegistry implements Cache {
  private activeCache: Cache
  private implementations: Map<string, Cache> = new Map()
  private metrics = cacheMetrics

  constructor(defaultImpl: Cache) {
    this.activeCache = defaultImpl
  }

  /**
   * 注册缓存实现
   */
  register(name: string, implementation: Cache): void {
    this.implementations.set(name, implementation)
  }

  /**
   * 切换活跃的缓存实现
   */
  switchTo(name: string): boolean {
    const impl = this.implementations.get(name)
    if (!impl) {
      return false
    }
    this.activeCache = impl
    this.metrics.switchCount.inc({ implementation: name })
    return true
  }

  /**
   * Get with metrics
   */
  async get<T = any>(key: string): Promise<Result<T | null>> {
    const start = Date.now()
    const result = await this.activeCache.get<T>(key)

    // 记录指标
    this.metrics.operations.inc({
      operation: 'get',
      status: result.ok ? 'success' : 'error'
    })
    this.metrics.duration.observe({ operation: 'get' }, Date.now() - start)

    if (result.ok && result.value !== null) {
      this.metrics.hits.inc()
    } else if (result.ok && result.value === null) {
      this.metrics.misses.inc()
    }

    return result
  }

  /**
   * Set with metrics
   */
  async set(key: string, value: any, ttl?: number): Promise<Result<void>> {
    const start = Date.now()
    const result = await this.activeCache.set(key, value, ttl)

    this.metrics.operations.inc({
      operation: 'set',
      status: result.ok ? 'success' : 'error'
    })
    this.metrics.duration.observe({ operation: 'set' }, Date.now() - start)

    return result
  }

  /**
   * Delete with metrics
   */
  async del(key: string): Promise<Result<void>> {
    const start = Date.now()
    const result = await this.activeCache.del(key)

    this.metrics.operations.inc({
      operation: 'del',
      status: result.ok ? 'success' : 'error'
    })
    this.metrics.duration.observe({ operation: 'del' }, Date.now() - start)

    return result
  }

  /**
   * 获取当前使用的缓存实现名称
   */
  getCurrentImplementation(): string {
    for (const [name, impl] of this.implementations) {
      if (impl === this.activeCache) {
        return name
      }
    }
    return 'unknown'
  }

  /**
   * 获取所有已注册的实现
   */
  getRegisteredImplementations(): string[] {
    return Array.from(this.implementations.keys())
  }
}
```

#### 2.3.2 NullCache (空实现)

**职责**:
- 提供无操作的缓存实现
- 作为默认实现（安全、零开销）
- 用于观测缓存调用模式

**代码示例**:
```typescript
// src/cache/implementations/null-cache.ts
import { Cache, Result } from '../../types/cache'

/**
 * NullCache - 无操作缓存实现
 *
 * 所有操作都立即成功返回，但不实际存储数据。
 * 用途：
 * 1. 作为默认实现，确保系统不依赖缓存
 * 2. 观测缓存调用模式和频率
 * 3. 作为性能基准（零缓存开销）
 */
export class NullCache implements Cache {
  async get<T = any>(key: string): Promise<Result<T | null>> {
    // 永远返回 cache miss
    return { ok: true, value: null }
  }

  async set(key: string, value: any, ttl?: number): Promise<Result<void>> {
    // 什么都不做，立即成功
    return { ok: true, value: undefined }
  }

  async del(key: string): Promise<Result<void>> {
    // 什么都不做，立即成功
    return { ok: true, value: undefined }
  }
}
```

#### 2.3.3 Cache Metrics (指标收集)

```typescript
// src/cache/metrics.ts
import { Counter, Histogram } from 'prom-client'

export const cacheMetrics = {
  operations: new Counter({
    name: 'cache_operations_total',
    help: 'Total cache operations',
    labelNames: ['operation', 'status'] // get/set/del, success/error
  }),

  hits: new Counter({
    name: 'cache_hits_total',
    help: 'Total cache hits'
  }),

  misses: new Counter({
    name: 'cache_misses_total',
    help: 'Total cache misses'
  }),

  duration: new Histogram({
    name: 'cache_operation_duration_milliseconds',
    help: 'Cache operation duration',
    labelNames: ['operation'],
    buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000]
  }),

  switchCount: new Counter({
    name: 'cache_implementation_switches_total',
    help: 'Total cache implementation switches',
    labelNames: ['implementation']
  })
}
```

### 2.4 使用示例

```typescript
// 初始化（在应用启动时）
import { CacheRegistry } from './cache/registry'
import { NullCache } from './cache/implementations/null-cache'

const cacheRegistry = new CacheRegistry(new NullCache())

// 注册 NullCache
cacheRegistry.register('null', new NullCache())

// 导出单例
export const cache = cacheRegistry

// ==========================================

// 业务代码中使用（未来迁移时）
import { cache } from '../cache'

async function getUserById(userId: string) {
  // 尝试从缓存获取
  const cachedResult = await cache.get<User>(`user:${userId}`)

  if (cachedResult.ok && cachedResult.value) {
    // Cache hit
    return cachedResult.value
  }

  // Cache miss - 从数据库查询
  const user = await db.users.findById(userId)

  // 写入缓存
  await cache.set(`user:${userId}`, user, 3600)

  return user
}
```

### 2.5 Metrics 暴露

通过 Prometheus 导出端点暴露缓存指标：

```typescript
// src/routes/metrics.ts
import { Router } from 'express'
import { register } from 'prom-client'

const router = Router()

router.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType)
  res.end(await register.metrics())
})

export default router
```

访问 `http://localhost:8900/metrics` 可以看到：
```
# HELP cache_operations_total Total cache operations
# TYPE cache_operations_total counter
cache_operations_total{operation="get",status="success"} 1234
cache_operations_total{operation="set",status="success"} 567

# HELP cache_hits_total Total cache hits
# TYPE cache_hits_total counter
cache_hits_total 0

# HELP cache_misses_total Total cache misses
# TYPE cache_misses_total counter
cache_misses_total 1234
```

### 2.6 配置和功能开关

```typescript
// src/config/cache.ts
export const cacheConfig = {
  enabled: process.env.FEATURE_CACHE === 'true',
  implementation: process.env.CACHE_IMPL || 'null', // 'null' | 'redis' | 'memory'
  ttl: parseInt(process.env.CACHE_DEFAULT_TTL || '3600'),

  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD
  }
}
```

**环境变量**:
- `FEATURE_CACHE=true` - 启用缓存系统（默认 false）
- `CACHE_IMPL=null` - 使用的缓存实现（默认 null）
- `CACHE_DEFAULT_TTL=3600` - 默认 TTL（秒）

### 2.7 实施步骤

1. **创建分支** (5 分钟)
   ```bash
   git checkout -b feat/cache-registry-nullcache
   ```

2. **创建目录结构** (5 分钟)
   ```bash
   mkdir -p packages/core-backend/src/cache/{implementations,__tests__}
   ```

3. **实现 NullCache** (30 分钟)
   - `src/cache/implementations/null-cache.ts`
   - `src/cache/implementations/__tests__/null-cache.test.ts`

4. **实现 CacheRegistry** (2 小时)
   - `src/cache/registry.ts`
   - `src/cache/metrics.ts`
   - `src/cache/index.ts`
   - `src/cache/__tests__/registry.test.ts`

5. **配置管理** (30 分钟)
   - `src/config/cache.ts`
   - 环境变量验证

6. **Metrics 端点** (30 分钟)
   - 确认 `/metrics` 已存在或创建

7. **测试** (1 小时)
   - 单元测试
   - 集成测试（启动服务验证 metrics）

8. **文档** (30 分钟)
   - README 或 docs/cache-phase1.md

**预计总时间**: 5-6 小时

---

## 📊 并行实施建议

### 选项 A: 串行实施
1. 先完成 `plugin-telemetry-otel` (Day 1-2)
2. 再完成 `Cache Phase 1` (Day 2-3)

**优点**: 专注，减少上下文切换
**缺点**: 总时间较长

### 选项 B: 并行实施 (推荐)
1. Day 1 上午: 创建两个分支，配置基础结构
2. Day 1 下午 - Day 2: 核心功能实现（可交替进行）
3. Day 3: 测试、文档、PR

**优点**: 利用碎片时间，总时间更短
**缺点**: 需要管理两个分支

### 推荐方案 (选项 B 变体)
```bash
# Day 1 上午
git checkout main
git checkout -b feat/batch2-infrastructure

# 在同一个分支实现两个任务
plugins/plugin-telemetry-otel/...
packages/core-backend/src/cache/...

# Day 3
# 拆分为两个 PR
git checkout -b feat/plugin-telemetry-otel
# cherry-pick plugin commits

git checkout feat/batch2-infrastructure
git checkout -b feat/cache-registry-nullcache
# cherry-pick cache commits
```

---

## ✅ 验收标准

### plugin-telemetry-otel
- [ ] `FEATURE_OTEL=false` 时插件不加载
- [ ] `FEATURE_OTEL=true` 时可访问 `/metrics` 端点
- [ ] Metrics 端点返回至少 3 个 HTTP metrics
- [ ] 1 个 smoke test 通过
- [ ] README.md 包含快速开始指南
- [ ] 构建成功 (`pnpm build`)

### Cache Phase 1
- [ ] CacheRegistry 可以注册多个实现
- [ ] CacheRegistry 可以在运行时切换实现
- [ ] NullCache 所有操作返回成功
- [ ] NullCache get 永远返回 null (cache miss)
- [ ] 所有 cache 操作都产生 metrics
- [ ] `/metrics` 端点暴露缓存指标
- [ ] 单元测试覆盖 >80%

### 通用
- [ ] CI 所有检查通过
- [ ] 无 linting 错误
- [ ] TypeScript 编译无错误
- [ ] 文档完整（README 或 docs/）

---

## 🔗 相关文档

- **Batch 1 验收报告**: `BATCH1_POST_MERGE_VALIDATION.md`
- **Cache 接口定义**: `packages/core-backend/types/cache.ts`
- **现有插件参考**: `plugins/plugin-audit-logger/`
- **OpenTelemetry 官方文档**: https://opentelemetry.io/docs/languages/js/

---

## 📋 后续计划

### Batch 3: Cache Phase 2 - Redis 实现
- RedisCache 实现
- 迁移 1-2 个高频接口使用缓存
- 缓存预热和失效策略

### Batch 4: OTel Phase 2 - 深度集成
- 数据库查询 tracing
- Redis 操作 metrics
- 自定义业务 metrics
- Jaeger 集成

---

**创建人**: Claude Code Assistant
**版本**: 1.0
**最后更新**: 2025-11-03
