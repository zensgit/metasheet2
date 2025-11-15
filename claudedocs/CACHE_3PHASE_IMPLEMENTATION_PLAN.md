# 缓存系统三阶段实施计划

**创建时间**: 2025-11-03 10:15 CST
**决策**: 关闭PR #144，采用渐进式三阶段方案
**原则**: 最小风险、最大复用、观测优先

---

## 🎯 总体策略

### 为什么关闭PR #144？

**原因**:
1. **规模过大**: +2582行代码，13个新依赖，200+ TypeScript错误
2. **风险太高**: 一次性引入Redis集群、OpenTelemetry、Elasticsearch
3. **缺乏验证**: 未证明需要分布式缓存
4. **架构冲突**: 直接集成到core，违反microkernel原则

**但我们保留代码价值**:
- PR #144的设计和实现非常优秀
- 将其作为Phase 3的参考实现
- 代码存入experimental包作为技术储备

---

## 📐 三阶段路线图

```
Phase 1: Observability (本周, 2-3h)
   ↓  证明需求 & 收集数据
Phase 2: Edge Cache (下周, 1-2h)
   ↓  验证效果 & 48h观测
Phase 3: Plugin Redis (2-3周后, 如验证通过)
   ↓  完整实现 & 金丝雀部署
```

### 关键里程碑

| 阶段 | 完成标准 | Go/No-Go决策点 |
|------|---------|---------------|
| Phase 1 | Metrics显示cache candidates | Phase 2是否有价值？ |
| Phase 2 | Edge cache hit rate >30% | Phase 3是否需要？ |
| Phase 3 | 金丝雀成功48h | 全量部署 |

---

## 🔧 Phase 1: Observability Foundation

**目标**: 建立缓存观测基础，证明需求存在
**时间**: 2-3小时
**风险**: 🟢 零风险（只加metrics，不改行为）

### 1.1 文件创建清单

#### A. 类型定义
**文件**: `metasheet-v2/packages/core-backend/types/cache.ts`
```typescript
/**
 * Unified Cache interface - Foundation for all cache implementations
 */
export interface Cache {
  /**
   * Get value by key
   * @returns Result<T> with value or null if miss
   */
  get<T = any>(key: string): Promise<Result<T | null>>

  /**
   * Set value with optional TTL
   * @param ttl - Time to live in seconds
   */
  set(key: string, value: any, ttl?: number): Promise<Result<void>>

  /**
   * Delete key
   */
  del(key: string): Promise<Result<void>>

  /**
   * Optional: Tag-based invalidation
   */
  tags?: {
    invalidate(tag: string): Promise<Result<void>>
  }
}

/**
 * Result type for cache operations
 */
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: Error }
```

**验证**: `pnpm -F @metasheet/core-backend typecheck` 通过

#### B. NullCache实现
**文件**: `metasheet-v2/packages/core-backend/core/cache/NullCache.ts`
```typescript
import { Cache, Result } from '../../types/cache'
import { metrics } from '../../metrics/metrics'

/**
 * No-op cache implementation for observability
 * Records metrics but performs no actual caching
 */
export class NullCache implements Cache {
  async get<T>(key: string): Promise<Result<T | null>> {
    metrics.cache_miss_total.inc({ impl: 'null' })
    return { ok: true, value: null }
  }

  async set(key: string, value: any, ttl?: number): Promise<Result<void>> {
    metrics.cache_set_total.inc({ impl: 'null' })
    return { ok: true, value: undefined }
  }

  async del(key: string): Promise<Result<void>> {
    metrics.cache_del_total.inc({ impl: 'null' })
    return { ok: true, value: undefined }
  }
}
```

**验证**: 单元测试通过，metrics正常增长

#### C. CacheRegistry
**文件**: `metasheet-v2/packages/core-backend/core/cache/CacheRegistry.ts`
```typescript
import { Cache } from '../../types/cache'
import { NullCache } from './NullCache'

/**
 * Singleton managing active cache implementation
 * Supports runtime switching between implementations
 */
export class CacheRegistry {
  private static instance: CacheRegistry
  private current: Cache = new NullCache()
  private implName: string = 'NullCache'
  private stats = {
    registeredAt: new Date(),
    hits: 0,
    misses: 0,
    errors: 0
  }

  static getInstance(): CacheRegistry {
    if (!this.instance) {
      this.instance = new CacheRegistry()
    }
    return this.instance
  }

  /**
   * Register new cache implementation
   * Can be called at runtime to hot-swap implementations
   */
  register(impl: Cache, name: string): void {
    this.current = impl
    this.implName = name
    this.stats.registeredAt = new Date()
    console.log(`[CacheRegistry] Switched to: ${name}`)
  }

  /**
   * Get current active cache
   */
  get(): Cache {
    return this.current
  }

  /**
   * Get registry status for /internal/cache endpoint
   */
  getStatus() {
    return {
      enabled: this.implName !== 'NullCache',
      implName: this.implName,
      stats: this.stats
    }
  }

  /**
   * Update stats (called by cache implementations)
   */
  recordHit(): void { this.stats.hits++ }
  recordMiss(): void { this.stats.misses++ }
  recordError(): void { this.stats.errors++ }
}

// Export singleton instance
export const cacheRegistry = CacheRegistry.getInstance()
```

**验证**: Runtime切换测试，状态查询正常

#### D. Metrics定义
**文件**: `metasheet-v2/packages/core-backend/metrics/metrics.ts` (修改)
```typescript
import { Counter, Gauge } from 'prom-client'

// ... existing metrics ...

// Cache metrics
export const metrics = {
  // ... existing metrics ...

  // Cache operations
  cache_hits_total: new Counter({
    name: 'cache_hits_total',
    help: 'Total cache hits',
    labelNames: ['impl', 'key_pattern']
  }),

  cache_miss_total: new Counter({
    name: 'cache_miss_total',
    help: 'Total cache misses',
    labelNames: ['impl', 'key_pattern']
  }),

  cache_set_total: new Counter({
    name: 'cache_set_total',
    help: 'Total cache sets',
    labelNames: ['impl', 'key_pattern']
  }),

  cache_del_total: new Counter({
    name: 'cache_del_total',
    help: 'Total cache deletions',
    labelNames: ['impl', 'key_pattern']
  }),

  cache_errors_total: new Counter({
    name: 'cache_errors_total',
    help: 'Total cache errors',
    labelNames: ['impl', 'error_type']
  }),

  cache_invalidate_total: new Counter({
    name: 'cache_invalidate_total',
    help: 'Total cache invalidations',
    labelNames: ['impl', 'tag']
  }),

  // Cache state
  cache_enabled: new Gauge({
    name: 'cache_enabled',
    help: 'Whether cache is enabled (1=enabled, 0=disabled)',
    labelNames: ['impl']
  }),

  // Cache candidates (for Phase 2 decision)
  cache_candidate_requests: new Counter({
    name: 'cache_candidate_requests',
    help: 'Requests that could benefit from caching',
    labelNames: ['route', 'method']
  })
}
```

**验证**: Prometheus `/metrics` 端点显示新指标

#### E. Internal Endpoint
**文件**: `metasheet-v2/packages/core-backend/routes/internal.ts` (修改)
```typescript
import { Router } from 'express'
import { cacheRegistry } from '../core/cache/CacheRegistry'

const router = Router()

// ... existing routes ...

/**
 * Cache status endpoint (dev/staging only)
 * GET /internal/cache
 */
router.get('/cache', (req, res) => {
  // Only available in non-production
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not available in production' })
  }

  const status = cacheRegistry.getStatus()
  res.json({
    enabled: status.enabled,
    implName: status.implName,
    registeredAt: status.stats.registeredAt,
    recentStats: {
      hits: status.stats.hits,
      misses: status.stats.misses,
      errors: status.stats.errors,
      hitRate: status.stats.hits / (status.stats.hits + status.stats.misses) || 0
    }
  })
})

export default router
```

**验证**: `curl http://localhost:8900/internal/cache` 返回正确状态

#### F. Configuration
**文件**: `metasheet-v2/packages/core-backend/.env.example` (添加)
```bash
# Cache Configuration (Phase 1)
FEATURE_CACHE=false                # Master switch for caching
CACHE_IMPL=null                     # null|redis (Phase 3)
```

### 1.2 集成到core
**文件**: `metasheet-v2/packages/core-backend/src/index.ts` (修改)
```typescript
import { cacheRegistry } from './core/cache/CacheRegistry'

class MetasheetServer {
  constructor() {
    // ... existing initialization ...

    // Initialize cache (Phase 1: NullCache only)
    this.initializeCache()
  }

  private initializeCache() {
    // Phase 1: Always use NullCache for observation
    // Phase 3 will register RedisCache here
    const enabled = process.env.FEATURE_CACHE === 'true'
    this.logger.info(`Cache: ${enabled ? 'observing' : 'disabled'}`)
  }
}
```

### 1.3 验收标准

**Build & Test**:
```bash
cd metasheet-v2/packages/core-backend
pnpm typecheck   # ✅ Pass
pnpm test        # ✅ Pass
pnpm build       # ✅ Pass
```

**Runtime验证**:
```bash
# Start server
pnpm dev:core

# Check metrics endpoint
curl http://localhost:8900/metrics | grep cache_

# Expected output:
# cache_hits_total{impl="null"} 0
# cache_miss_total{impl="null"} 0
# cache_enabled{impl="null"} 0

# Check internal endpoint
curl http://localhost:8900/internal/cache
# Expected: {"enabled":false,"implName":"NullCache",...}
```

**Prometheus验证**:
```promql
# 查询cache相关metrics
cache_miss_total
cache_candidate_requests
```

**输出**: PR #1 "feat(cache): Phase 1 - Observability foundation"

---

## 🌐 Phase 2: Edge Cache Pilot

**目标**: 验证边缘缓存是否满足需求
**时间**: 1-2小时
**风险**: 🟢 极低（非侵入式，易回退）

### 2.1 Cache Headers中间件

**文件**: `metasheet-v2/packages/core-backend/middleware/cacheHeaders.ts`
```typescript
import { Request, Response, NextFunction } from 'express'
import { createHash } from 'crypto'
import { metrics } from '../metrics/metrics'

/**
 * Add cache headers for stable, non-personalized routes
 * Only GET requests, no user-specific data
 */
export function cacheHeadersMiddleware(req: Request, res: Response, next: NextFunction) {
  // Only for GET requests
  if (req.method !== 'GET') {
    return next()
  }

  // Skip personalized routes
  const personalizedRoutes = ['/api/user', '/api/profile', '/api/notifications']
  if (personalizedRoutes.some(route => req.path.startsWith(route))) {
    return next()
  }

  // Mark as cache candidate
  metrics.cache_candidate_requests.inc({
    route: req.route?.path || req.path,
    method: req.method
  })

  // Generate ETag from response
  const originalSend = res.send
  res.send = function(body: any): Response {
    if (res.statusCode === 200) {
      const etag = generateETag(body)

      // Set cache headers
      res.setHeader('ETag', etag)
      res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate')
      res.setHeader('Vary', 'Authorization')

      // Check if client has valid cache
      if (req.headers['if-none-match'] === etag) {
        res.status(304)
        return originalSend.call(this, '')
      }
    }

    return originalSend.call(this, body)
  }

  next()
}

function generateETag(body: any): string {
  const content = typeof body === 'string' ? body : JSON.stringify(body)
  return `"${createHash('md5').update(content).digest('hex')}"`
}
```

**应用到路由**:
```typescript
// src/index.ts
import { cacheHeadersMiddleware } from './middleware/cacheHeaders'

app.use('/api/public', cacheHeadersMiddleware)
app.use('/api/data', cacheHeadersMiddleware)
```

### 2.2 Nginx/Varnish配置指南

**文件**: `metasheet-v2/docs/EDGE_CACHE_GUIDE.md`
```markdown
# Edge Cache Configuration Guide

## Nginx Proxy Cache

```nginx
# nginx.conf
proxy_cache_path /var/cache/nginx levels=1:2 keys_zone=api_cache:10m max_size=100m inactive=60m;

server {
  location /api/ {
    proxy_pass http://backend:8900;

    # Cache configuration
    proxy_cache api_cache;
    proxy_cache_key "$request_uri$http_authorization";
    proxy_cache_valid 200 60s;
    proxy_cache_methods GET;

    # Respect backend cache headers
    proxy_cache_use_stale error timeout updating;

    # Add cache status header
    add_header X-Cache-Status $upstream_cache_status;
  }
}
```

## Varnish Configuration

```vcl
# default.vcl
backend default {
  .host = "backend";
  .port = "8900";
}

sub vcl_recv {
  # Only cache GET requests
  if (req.method != "GET") {
    return (pass);
  }

  # Include Authorization in cache key
  if (req.http.Authorization) {
    set req.http.X-Auth-Hash = hash(req.http.Authorization);
  }
}

sub vcl_backend_response {
  # Respect Cache-Control from backend
  if (beresp.http.Cache-Control ~ "public") {
    set beresp.ttl = 60s;
  }
}
```

## 10% Canary Validation

**Day 1-2**: Nginx缓存监控
```bash
# Check cache hit rate
tail -f /var/log/nginx/access.log | grep "X-Cache-Status: HIT"

# Prometheus query
sum(rate(nginx_http_requests_total{cache_status="HIT"}[5m]))
  /
sum(rate(nginx_http_requests_total[5m]))
```

**Decision criteria**:
- Hit rate > 30%: 继续Phase 3
- Hit rate < 10%: 停止，不需要Redis
```

### 2.3 Metrics收集

**新增metrics**:
```typescript
// metrics/metrics.ts (添加)
cache_edge_candidates_total: new Counter({
  name: 'cache_edge_candidates_total',
  help: 'Total requests eligible for edge caching'
}),

etag_match_total: new Counter({
  name: 'etag_match_total',
  help: 'Total 304 Not Modified responses'
})
```

### 2.4 验收标准

**48小时观测期**:
```promql
# Hit rate calculation
sum(rate(etag_match_total[1h])) / sum(rate(cache_candidate_requests[1h]))

# Candidate volume
sum(rate(cache_candidate_requests[1h]))
```

**Go/No-Go Decision**:
- ✅ Hit rate > 30% → 进入Phase 3
- ✅ Candidate volume > 100 req/s → Redis有价值
- ❌ Hit rate < 10% → 停止，Edge cache已足够

**输出**: PR #2 "feat(cache): Phase 2 - Edge cache with headers"

---

## 🔌 Phase 3: Plugin-cache-redis

**前提条件**: Phase 2验证通过 (hit rate > 30%)
**时间**: 2-3周（含测试和金丝雀）
**风险**: 🟡 中等（plugin隔离，可降级）

### 3.1 Plugin结构

```
metasheet-v2/
└── plugins/
    └── plugin-cache-redis/
        ├── plugin.json
        ├── package.json
        ├── src/
        │   ├── index.ts              # activate() + deactivate()
        │   ├── RedisCache.ts         # 从PR #144移植
        │   ├── CacheMiddleware.ts    # Express middleware
        │   └── config.ts             # Redis配置
        ├── test/
        │   ├── RedisCache.test.ts
        │   └── integration.test.ts
        └── README.md
```

### 3.2 文件映射 (从PR #144)

**Source (PR #144)** → **Target (Plugin)**:

| PR #144文件 | Plugin文件 | 改动 |
|------------|-----------|------|
| `src/cache/RedisCache.ts` | `src/RedisCache.ts` | ✅ 直接移植 |
| `src/cache/CacheManager.ts` | - | ❌ 删除（Registry替代） |
| `src/middleware/cache.ts` | `src/CacheMiddleware.ts` | ✅ 简化移植 |
| `docs/REDIS_CACHE_SYSTEM.md` | `README.md` | ✅ 整合 |

**移除内容**:
- CacheManager的L1/L2逻辑 → 简化为单层Redis
- OpenTelemetry auto-instrumentation → 使用Phase 1 metrics
- Elasticsearch adapter → 不移植（超出范围）

### 3.3 plugin.json

```json
{
  "id": "cache-redis",
  "name": "Redis Distributed Cache",
  "version": "1.0.0",
  "description": "Distributed caching with Redis (cluster/sentinel support)",
  "author": "Metasheet Team",
  "capabilities": ["cache"],
  "featureFlags": {
    "required": ["FEATURE_CACHE_REDIS"],
    "optional": []
  },
  "dependencies": {
    "ioredis": "^5.3.0"
  },
  "config": {
    "REDIS_URL": "redis://localhost:6379",
    "REDIS_MODE": "single",
    "REDIS_KEY_PREFIX": "metasheet:",
    "REDIS_DEFAULT_TTL": 3600
  }
}
```

### 3.4 src/index.ts (Plugin Entry)

```typescript
import { PluginContext } from '@metasheet/plugin-api'
import { RedisCache } from './RedisCache'
import { cacheRegistry } from '@metasheet/core-backend/core/cache/CacheRegistry'
import { logger } from '@metasheet/core-backend/core/logger'

/**
 * Plugin activation
 * Registers RedisCache with CacheRegistry
 * Auto-degrades to NullCache on failure
 */
export async function activate(ctx: PluginContext) {
  // Check feature flag
  if (process.env.FEATURE_CACHE_REDIS !== 'true') {
    logger.info('[plugin-cache-redis] Disabled via feature flag')
    return
  }

  try {
    // Create and connect Redis cache
    const config = {
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      mode: process.env.REDIS_MODE || 'single',
      keyPrefix: process.env.REDIS_KEY_PREFIX || 'metasheet:',
      defaultTTL: parseInt(process.env.REDIS_DEFAULT_TTL || '3600')
    }

    const redisCache = new RedisCache(config)
    await redisCache.connect()

    // Register with global registry
    cacheRegistry.register(redisCache, 'RedisCache')

    logger.info('[plugin-cache-redis] Activated successfully', { config })

    // Health check interval
    const healthCheck = setInterval(async () => {
      const health = await redisCache.healthCheck()
      if (!health.ok) {
        logger.error('[plugin-cache-redis] Health check failed', { error: health.error })
      }
    }, 30000)

    ctx.onDeactivate(() => {
      clearInterval(healthCheck)
    })

  } catch (error) {
    logger.error('[plugin-cache-redis] Activation failed, degrading to NullCache', { error })
    // Registry保持NullCache，系统继续运行
  }
}

/**
 * Plugin deactivation
 * Graceful shutdown of Redis connections
 */
export async function deactivate(ctx: PluginContext) {
  logger.info('[plugin-cache-redis] Deactivating...')
  // Disconnect handled by plugin system
}
```

### 3.5 src/RedisCache.ts

**直接移植PR #144的实现**，但简化：
- 移除L1/L2 CacheManager逻辑
- 移除OpenTelemetry auto-instrumentation（使用Phase 1 metrics）
- 保留核心功能：
  - ✅ Single/Cluster/Sentinel支持
  - ✅ Tag-based invalidation
  - ✅ Compression
  - ✅ Distributed locking
  - ✅ Pub/Sub (optional)

```typescript
import Redis, { Cluster, RedisOptions } from 'ioredis'
import { Cache, Result } from '@metasheet/core-backend/types/cache'
import { metrics } from '@metasheet/core-backend/metrics/metrics'

export class RedisCache implements Cache {
  private client: Redis | Cluster
  private config: RedisConfig

  constructor(config: RedisConfig) {
    this.config = config

    // Initialize Redis client based on mode
    if (config.mode === 'cluster') {
      this.client = new Redis.Cluster(config.clusterNodes!, config.options)
    } else if (config.mode === 'sentinel') {
      this.client = new Redis({
        sentinels: config.sentinels!,
        name: config.sentinelName!,
        ...config.options
      })
    } else {
      this.client = new Redis(config.url, config.options)
    }
  }

  async connect(): Promise<void> {
    await this.client.ping()
  }

  async get<T>(key: string): Promise<Result<T | null>> {
    try {
      const value = await this.client.get(this.prefixKey(key))
      metrics.cache_hits_total.inc({ impl: 'redis', key_pattern: this.extractPattern(key) })

      if (!value) {
        metrics.cache_miss_total.inc({ impl: 'redis', key_pattern: this.extractPattern(key) })
        return { ok: true, value: null }
      }

      return { ok: true, value: JSON.parse(value) as T }
    } catch (error) {
      metrics.cache_errors_total.inc({ impl: 'redis', error_type: 'get' })
      return { ok: false, error: error as Error }
    }
  }

  async set(key: string, value: any, ttl?: number): Promise<Result<void>> {
    try {
      const prefixedKey = this.prefixKey(key)
      const serialized = JSON.stringify(value)
      const finalTTL = ttl || this.config.defaultTTL

      await this.client.setex(prefixedKey, finalTTL, serialized)
      metrics.cache_set_total.inc({ impl: 'redis', key_pattern: this.extractPattern(key) })

      return { ok: true, value: undefined }
    } catch (error) {
      metrics.cache_errors_total.inc({ impl: 'redis', error_type: 'set' })
      return { ok: false, error: error as Error }
    }
  }

  async del(key: string): Promise<Result<void>> {
    try {
      await this.client.del(this.prefixKey(key))
      metrics.cache_del_total.inc({ impl: 'redis', key_pattern: this.extractPattern(key) })
      return { ok: true, value: undefined }
    }
    catch (error) {
      metrics.cache_errors_total.inc({ impl: 'redis', error_type: 'del' })
      return { ok: false, error: error as Error }
    }
  }

  // Tag-based invalidation
  tags = {
    invalidate: async (tag: string): Promise<Result<void>> => {
      try {
        const pattern = this.prefixKey(`tag:${tag}:*`)
        const keys = await this.scanKeys(pattern)

        if (keys.length > 0) {
          await this.client.del(...keys)
        }

        metrics.cache_invalidate_total.inc({ impl: 'redis', tag })
        return { ok: true, value: undefined }
      } catch (error) {
        metrics.cache_errors_total.inc({ impl: 'redis', error_type: 'invalidate' })
        return { ok: false, error: error as Error }
      }
    }
  }

  async healthCheck(): Promise<Result<void>> {
    try {
      await this.client.ping()
      return { ok: true, value: undefined }
    } catch (error) {
      return { ok: false, error: error as Error }
    }
  }

  private prefixKey(key: string): string {
    return `${this.config.keyPrefix}${key}`
  }

  private extractPattern(key: string): string {
    return key.split(':')[0] || 'unknown'
  }

  private async scanKeys(pattern: string): Promise<string[]> {
    const keys: string[] = []
    let cursor = '0'

    do {
      const [newCursor, foundKeys] = await this.client.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        100
      )
      cursor = newCursor
      keys.push(...foundKeys)
    } while (cursor !== '0')

    return keys
  }
}

interface RedisConfig {
  url?: string
  mode: 'single' | 'cluster' | 'sentinel'
  keyPrefix: string
  defaultTTL: number
  clusterNodes?: Array<{ host: string; port: number }>
  sentinels?: Array<{ host: string; port: number }>
  sentinelName?: string
  options?: RedisOptions
}
```

### 3.6 金丝雀部署

**10% → 50% → 100% rollout**:

```yaml
# .env configuration
FEATURE_CACHE_REDIS=true
CACHE_REDIS_ROLLOUT_PERCENT=10    # Start with 10%
REDIS_URL=redis://redis-cluster:6379
REDIS_MODE=cluster
```

**Rollout logic** (in plugin):
```typescript
// src/index.ts
function shouldEnableForRequest(req: Request): boolean {
  const rolloutPercent = parseInt(process.env.CACHE_REDIS_ROLLOUT_PERCENT || '0')

  // Deterministic rollout based on user ID
  const userId = req.user?.id || 'anonymous'
  const hash = createHash('md5').update(userId).digest('hex')
  const bucket = parseInt(hash.substring(0, 8), 16) % 100

  return bucket < rolloutPercent
}
```

**48h观测期 (每个阶段)**:
```promql
# Error rate
sum(rate(cache_errors_total{impl="redis"}[1h]))
  /
sum(rate(cache_hits_total{impl="redis"}[1h] + cache_miss_total{impl="redis"}[1h]))

# Hit rate
sum(rate(cache_hits_total{impl="redis"}[1h]))
  /
sum(rate(cache_hits_total{impl="redis"}[1h] + cache_miss_total{impl="redis"}[1h]))
```

**Go criteria**:
- ✅ Error rate < 0.1%
- ✅ Hit rate > 40%
- ✅ P99 latency < 50ms
- ✅ No Redis connection issues

### 3.7 验收标准

**功能测试**:
```bash
# Plugin installation
cd plugins/plugin-cache-redis
pnpm install
pnpm build
pnpm test

# Integration test
FEATURE_CACHE_REDIS=true pnpm -F @metasheet/core-backend test:integration
```

**性能基准**:
```typescript
// benchmark/cache-performance.ts
await benchmark('Redis Cache', async () => {
  const cache = new RedisCache(config)

  // Write 10k keys
  for (let i = 0; i < 10000; i++) {
    await cache.set(`key:${i}`, { data: 'test' }, 3600)
  }

  // Read 10k keys
  for (let i = 0; i < 10000; i++) {
    await cache.get(`key:${i}`)
  }
})

// Target: <5ms P99 latency
```

**输出**: PR #3 "feat(cache): Phase 3 - Redis plugin implementation"

---

## 🎁 Bonus Items

### Bonus 1: 修复 approvals.ts 异步处理器

**问题**: PR #144中包含的修复 (4个POST handlers缺少async)

**文件**: `metasheet-v2/packages/core-backend/src/routes/approvals.ts`

**修复** (已在PR #144中):
```typescript
// Before (错误):
router.post('/submit', (req, res) => {
  await approvalService.submit(req.body)  // ❌ await in non-async
})

// After (正确):
router.post('/submit', async (req, res) => {
  await approvalService.submit(req.body)  // ✅ async handler
})
```

**4个需要修复的handlers**:
1. POST `/submit`
2. POST `/approve`
3. POST `/reject`
4. POST `/cancel`

**独立PR**: PR #0 "fix(approvals): restore async keywords for POST handlers"
**时间**: 10分钟
**优先级**: ⭐⭐⭐ 立即执行（快速胜利）

### Bonus 2: Experimental Package

**目的**: 保存PR #144原始代码作为技术参考

**结构**:
```
metasheet-v2/
└── packages/
    └── cache-experimental/
        ├── package.json
        ├── README.md  (说明这是实验性代码)
        ├── src/
        │   ├── CacheManager.ts      # PR #144原版
        │   ├── RedisCache.ts        # PR #144原版
        │   └── middleware/
        └── docs/
            └── ORIGINAL_PR144.md    # PR #144的完整文档
```

**package.json**:
```json
{
  "name": "@metasheet/cache-experimental",
  "version": "0.0.1-experimental",
  "private": true,
  "description": "Experimental cache implementations (not for production)",
  "keywords": ["experimental", "reference", "redis", "cache"]
}
```

**README.md**:
```markdown
# ⚠️ Experimental Cache Implementation

This package contains the original Redis cache implementation from PR #144.

**Status**: Reference only, not production-ready
**Purpose**: Technical reference for future cache development
**Origin**: [PR #144](https://github.com/zensgit/smartsheet/pull/144)

## Why not used directly?

1. Too large (+2582 lines) - should be split into phases
2. Missing dependencies (13 packages)
3. 200+ TypeScript errors need fixing
4. Needs architecture alignment with plugin system

## Migration Path

See `claudedocs/CACHE_3PHASE_IMPLEMENTATION_PLAN.md` for the production-ready approach.

---

**Do not import this package in production code.**
```

---

## 📊 决策矩阵

### Phase 2 Go/No-Go Decision

| Metric | Threshold | Action if NOT met |
|--------|-----------|------------------|
| Edge hit rate | > 30% | Stop, Edge cache sufficient |
| Candidate volume | > 100 req/s | Stop, volume too low |
| 304 rate | > 20% | Stop, ETag working well |

### Phase 3 Rollout Gates

| Stage | Success Criteria | Rollback Trigger |
|-------|-----------------|------------------|
| 10% | Error rate < 0.1%, 48h stable | Error rate > 1% |
| 50% | Hit rate > 40%, P99 < 50ms | Hit rate drops >10% |
| 100% | All metrics stable 7 days | Any degradation |

---

## 🔍 风险管理

### Phase 1风险
- **无**: 仅观测，无行为变更

### Phase 2风险
- **低**: Edge cache非侵入式
- **缓解**: 可随时移除Cache-Control headers

### Phase 3风险
- **中等**: Redis依赖，网络延迟
- **缓解**:
  - Plugin隔离，故障自动降级
  - 金丝雀部署，快速回滚
  - Metrics监控，告警触发

---

## 📅 时间表

| Week | Phase | Deliverable | Time |
|------|-------|------------|------|
| W1 (本周) | Phase 1 | Cache interface + NullCache + Metrics | 2-3h |
| W1 | Bonus 1 | Fix approvals.ts async | 10m |
| W2 | Phase 2 | Edge cache + headers + docs | 1-2h |
| W2 | Decision | Analyze 48h metrics | - |
| W3-W4 | Phase 3 (if go) | Redis plugin + tests | 8-12h |
| W4-W5 | Phase 3 | Canary 10% → 50% → 100% | 1w |

**Total**: 4-5周（如果Phase 2验证通过）

---

## ✅ Success Metrics

### Phase 1 Success
- ✅ Build & typecheck pass
- ✅ Prometheus shows cache_* metrics
- ✅ /internal/cache returns status
- ✅ Zero production impact

### Phase 2 Success
- ✅ 48h data collected
- ✅ Hit rate > 30% OR
- ✅ Hit rate < 10% (stop decision)

### Phase 3 Success
- ✅ 100% rollout without issues
- ✅ Hit rate > 40% sustained
- ✅ P99 latency < 50ms
- ✅ Error rate < 0.1%
- ✅ Zero manual interventions

---

## 📚 Reference Materials

**PR #144原始内容**:
- Implementation: `packages/cache-experimental/`
- Documentation: `packages/core-backend/docs/REDIS_CACHE_SYSTEM.md`
- PR link: https://github.com/zensgit/smartsheet/pull/144

**Architecture Docs**:
- Plugin system: `docs/PLUGIN_ARCHITECTURE.md`
- Microkernel pattern: `docs/MICROKERNEL_DESIGN.md`

**Observability**:
- Prometheus: `docs/PROMETHEUS_SETUP.md`
- Grafana dashboards: `grafana/dashboards/`

---

## 🎯 总结

### 为什么这个计划更好？

| 维度 | 直接合并PR #144 | 三阶段方案 |
|-----|---------------|-----------|
| **风险** | 🔴 High | 🟢 Low → 🟡 Medium |
| **时间** | 8-16h一次性 | 4-6h分散3周 |
| **回滚** | 困难 | 每阶段可独立回滚 |
| **验证** | 事后验证 | 每阶段验证 |
| **架构** | 违反microkernel | 符合plugin设计 |
| **依赖** | 13个新依赖 | 渐进式引入 |
| **复用性** | 低（monolithic） | 高（plugin化） |

### 关键优势

1. **观测优先**: Phase 1证明需求存在
2. **渐进式验证**: 每阶段独立决策
3. **零风险开始**: Phase 1无生产影响
4. **快速止损**: 任何阶段可停止
5. **代码复用**: PR #144实现不浪费
6. **架构一致**: 符合microkernel原则

---

**计划创建**: 2025-11-03 10:15 CST
**预计完成**: 2025-11-28 (如全部通过)
**下一步**: 关闭PR #144 → 修复approvals.ts → 启动Phase 1

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
