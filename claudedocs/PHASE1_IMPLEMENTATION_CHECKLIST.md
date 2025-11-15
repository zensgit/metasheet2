# Phase 1实施检查清单

**开始时间**: 待定（等PR #346合并后）
**预计时间**: 2-3小时
**目标**: Cache Observability Foundation

---

## 📋 前置条件

### ✅ 环境准备

- [x] PR #346 CI运行中 (5/9 checks passed)
- [x] Main分支已更新
- [x] 工作区干净 (已切换到main)
- [ ] PR #346自动合并完成
- [ ] Main分支pull最新代码

### 📚 技术参考

**关键文档**:
- ✅ `CACHE_3PHASE_IMPLEMENTATION_PLAN.md` (详细方案)
- ✅ `CACHE_ARCHITECTURE_DECISION_20251103.md` (决策依据)
- ✅ `SESSION_SUMMARY_20251103.md` (今日总结)

---

## 🔧 实施步骤

### Step 1: 创建Feature Branch (5分钟)

```bash
# 1. 确保在main分支
git checkout main
git pull origin main

# 2. 创建feature branch
git checkout -b feature/cache-phase1-observability

# 3. 验证分支
git status
```

**验证点**:
- ✅ 分支名正确
- ✅ 基于最新main（包含PR #346的修复）

---

### Step 2: 创建Cache接口 (15分钟)

#### 2.1 创建types目录

```bash
mkdir -p types
```

#### 2.2 创建cache.ts

**文件**: `types/cache.ts`

**内容要点**:
- Cache接口定义（get/set/del/tags）
- Result<T>类型定义
- TSDoc注释

**代码模板** (from CACHE_3PHASE_IMPLEMENTATION_PLAN.md:139-166):
```typescript
/**
 * Unified Cache interface - Foundation for all cache implementations
 */
export interface Cache {
  get<T = any>(key: string): Promise<Result<T | null>>
  set(key: string, value: any, ttl?: number): Promise<Result<void>>
  del(key: string): Promise<Result<void>>
  tags?: {
    invalidate(tag: string): Promise<Result<void>>
  }
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: Error }
```

**验证**:
```bash
pnpm exec tsc types/cache.ts --noEmit
```

**预期**: 无TypeScript错误

---

### Step 3: 创建NullCache (20分钟)

#### 3.1 创建cache目录

```bash
mkdir -p core/cache
```

#### 3.2 创建NullCache.ts

**文件**: `core/cache/NullCache.ts`

**要点**:
- 实现Cache接口
- 所有操作都是no-op
- 记录metrics（cache_miss_total, cache_set_total, cache_del_total）
- TSDoc注释

**代码模板** (from CACHE_3PHASE_IMPLEMENTATION_PLAN.md:170-193):
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

**验证**:
```bash
pnpm exec tsc core/cache/NullCache.ts --noEmit
```

---

### Step 4: 创建CacheRegistry (30分钟)

#### 4.1 创建CacheRegistry.ts

**文件**: `core/cache/CacheRegistry.ts`

**要点**:
- Singleton模式
- 管理当前cache实现
- 支持runtime切换
- getStatus()方法用于/internal/cache
- 统计信息（hits/misses/errors）

**代码模板** (from CACHE_3PHASE_IMPLEMENTATION_PLAN.md:197-243):
```typescript
import { Cache } from '../../types/cache'
import { NullCache } from './NullCache'

/**
 * Singleton managing active cache implementation
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

  register(impl: Cache, name: string): void {
    this.current = impl
    this.implName = name
    this.stats.registeredAt = new Date()
    console.log(`[CacheRegistry] Switched to: ${name}`)
  }

  get(): Cache {
    return this.current
  }

  getStatus() {
    return {
      enabled: this.implName !== 'NullCache',
      implName: this.implName,
      stats: this.stats
    }
  }

  recordHit(): void { this.stats.hits++ }
  recordMiss(): void { this.stats.misses++ }
  recordError(): void { this.stats.errors++ }
}

export const cacheRegistry = CacheRegistry.getInstance()
```

**验证**:
```bash
pnpm exec tsc core/cache/CacheRegistry.ts --noEmit
```

---

### Step 5: 添加Cache Metrics (20分钟)

#### 5.1 修改metrics.ts

**文件**: `metrics/metrics.ts`

**添加内容** (from CACHE_3PHASE_IMPLEMENTATION_PLAN.md:247-285):
```typescript
import { Counter, Gauge } from 'prom-client'

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

cache_enabled: new Gauge({
  name: 'cache_enabled',
  help: 'Whether cache is enabled (1=enabled, 0=disabled)',
  labelNames: ['impl']
}),

cache_candidate_requests: new Counter({
  name: 'cache_candidate_requests',
  help: 'Requests that could benefit from caching',
  labelNames: ['route', 'method']
})
```

**注意**:
- 检查metrics对象的导出方式
- 确保不破坏现有metrics
- 保持代码格式一致

**验证**:
```bash
pnpm typecheck
```

---

### Step 6: 添加/internal/cache端点 (20分钟)

#### 6.1 修改routes/internal.ts

**文件**: `routes/internal.ts`

**检查是否存在**:
```bash
ls -la src/routes/internal.ts
# 如果不存在，需要创建
```

**添加内容** (from CACHE_3PHASE_IMPLEMENTATION_PLAN.md:289-313):
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

**注意**:
- 检查是否已有internal.ts路由
- 如果没有，需要在src/index.ts中注册路由
- 确保路由前缀正确（/internal/cache）

**验证**:
```bash
pnpm typecheck
```

---

### Step 7: 集成到Core (20分钟)

#### 7.1 修改src/index.ts

**添加import**:
```typescript
import { cacheRegistry } from './core/cache/CacheRegistry'
```

**添加初始化**:
```typescript
class MetasheetServer {
  constructor() {
    // ... existing initialization ...

    // Initialize cache (Phase 1: NullCache only)
    this.initializeCache()
  }

  private initializeCache() {
    // Phase 1: Always use NullCache for observation
    const enabled = process.env.FEATURE_CACHE === 'true'
    this.logger.info(`Cache: ${enabled ? 'observing' : 'disabled'}`)

    // Phase 3 will register RedisCache here
  }
}
```

**注册/internal路由** (如果之前没有):
```typescript
import internalRouter from './routes/internal'

// In setup method
app.use('/internal', internalRouter)
```

**验证**:
```bash
pnpm typecheck
```

---

### Step 8: 添加环境变量 (5分钟)

#### 8.1 修改.env.example

**文件**: `.env.example`

**添加**:
```bash
# Cache Configuration (Phase 1)
FEATURE_CACHE=false                # Master switch for caching
CACHE_IMPL=null                     # null|redis (Phase 3)
```

**验证**:
```bash
cat .env.example | grep CACHE
```

---

### Step 9: 完整构建测试 (15分钟)

#### 9.1 TypeCheck

```bash
pnpm typecheck
```

**预期**: 所有TypeScript检查通过

#### 9.2 Build

```bash
pnpm build
```

**预期**: 构建成功

#### 9.3 Test (如果有)

```bash
pnpm test
```

**预期**: 所有测试通过

---

### Step 10: Runtime验证 (15分钟)

#### 10.1 启动服务

```bash
pnpm dev
```

#### 10.2 验证/internal/cache端点

```bash
curl http://localhost:8900/internal/cache
```

**预期输出**:
```json
{
  "enabled": false,
  "implName": "NullCache",
  "registeredAt": "2025-11-03T...",
  "recentStats": {
    "hits": 0,
    "misses": 0,
    "errors": 0,
    "hitRate": 0
  }
}
```

#### 10.3 验证Prometheus metrics

```bash
curl http://localhost:8900/metrics | grep cache_
```

**预期输出**:
```
cache_hits_total{impl="null"} 0
cache_miss_total{impl="null"} 0
cache_enabled{impl="null"} 0
...
```

#### 10.4 停止服务

```bash
# Ctrl+C
```

---

### Step 11: 提交代码 (10分钟)

#### 11.1 检查变更

```bash
git status
git diff
```

**预期文件**:
- types/cache.ts (新建)
- core/cache/NullCache.ts (新建)
- core/cache/CacheRegistry.ts (新建)
- metrics/metrics.ts (修改)
- routes/internal.ts (修改或新建)
- src/index.ts (修改)
- .env.example (修改)

#### 11.2 Stage所有文件

```bash
git add types/cache.ts
git add core/cache/NullCache.ts
git add core/cache/CacheRegistry.ts
git add metrics/metrics.ts
git add routes/internal.ts
git add src/index.ts
git add .env.example
```

#### 11.3 Commit

```bash
git commit -m "feat(cache): Phase 1 - Observability foundation

Implements cache observability infrastructure as the foundation
for the 3-phase progressive cache implementation strategy.

## Phase 1: Observability Foundation

**Goal**: Establish cache observability without behavior changes

**Key Components**:
- Cache interface (types/cache.ts): Unified contract for all implementations
- NullCache: No-op implementation with metrics recording
- CacheRegistry: Singleton managing active cache implementation
- Prometheus metrics: cache_hits/misses/sets/dels/errors/enabled
- /internal/cache endpoint: Runtime status inspection (dev/staging only)

**Impact**:
- Zero risk: No production behavior changes
- Pure observation: Only metrics collection
- Foundation ready: Plugin system can register implementations
- Feature flag: FEATURE_CACHE for future enablement

## Validation

- [x] TypeScript typecheck passes
- [x] Build succeeds
- [x] /internal/cache returns status
- [x] Prometheus shows cache_* metrics

## Next Steps

- Phase 2: Edge cache pilot with Cache-Control headers
- Phase 3: Redis plugin (if Phase 2 validates need)

---

Related:
- Architecture: claudedocs/CACHE_ARCHITECTURE_DECISION_20251103.md
- Full Plan: claudedocs/CACHE_3PHASE_IMPLEMENTATION_PLAN.md
- Origin: Closed PR #144, preserved value in progressive approach

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
"
```

---

### Step 12: 推送并创建PR (10分钟)

#### 12.1 推送分支

```bash
git push -u origin feature/cache-phase1-observability
```

#### 12.2 创建PR

```bash
gh pr create \
  --title "feat(cache): Phase 1 - Observability foundation" \
  --body "$(cat <<'EOF'
## 🎯 Phase 1: Observability Foundation

First phase of the 3-phase progressive cache implementation strategy.

### Goal
Establish cache observability infrastructure without any production behavior changes.

### Architecture Decision
Closed PR #144 (direct Redis integration) in favor of progressive approach:
- **Phase 1**: Observability (this PR) - Zero risk
- **Phase 2**: Edge cache validation - Low risk
- **Phase 3**: Redis plugin - Medium risk (only if validated)

**Decision doc**: `claudedocs/CACHE_ARCHITECTURE_DECISION_20251103.md`

---

## 🔧 Changes

### New Files

**1. `types/cache.ts`** - Cache Interface
- Unified contract for all cache implementations
- Result<T> pattern for error handling
- Optional tag-based invalidation support

**2. `core/cache/NullCache.ts`** - No-op Implementation
- Implements Cache interface
- All operations are no-op (return immediately)
- Records metrics for observability

**3. `core/cache/CacheRegistry.ts`** - Implementation Manager
- Singleton pattern
- Manages active cache implementation
- Supports runtime hot-swapping
- Tracks stats (hits/misses/errors)
- Provides status for /internal/cache

### Modified Files

**4. `metrics/metrics.ts`** - Cache Metrics
Added Prometheus metrics:
- `cache_hits_total` - Cache hits counter
- `cache_miss_total` - Cache misses counter
- `cache_set_total` - Cache writes counter
- `cache_del_total` - Cache deletions counter
- `cache_errors_total` - Cache errors counter
- `cache_invalidate_total` - Tag invalidations counter
- `cache_enabled` - Cache enabled gauge
- `cache_candidate_requests` - Cacheable requests counter

**5. `routes/internal.ts`** - Status Endpoint
- `GET /internal/cache` - Returns cache status
- Dev/staging only (404 in production)
- Shows: enabled, implementation, stats, hit rate

**6. `src/index.ts`** - Core Integration
- Initialize cache on startup
- Currently: NullCache (observability only)
- Future: Plugin registration point

**7. `.env.example`** - Configuration
- `FEATURE_CACHE=false` - Master switch
- `CACHE_IMPL=null` - Implementation selector

---

## 📊 Impact Analysis

### Risk: 🟢 **None**
- **Behavior**: No changes to production logic
- **Performance**: Negligible (metrics only)
- **Dependencies**: Zero new dependencies
- **Rollback**: Not needed (no behavior changes)

### Benefits
- ✅ Foundation for future cache implementations
- ✅ Metrics collection starts immediately
- ✅ Status endpoint for debugging
- ✅ Plugin-ready architecture

---

## ✅ Validation

### Build & Test
```bash
pnpm typecheck  # ✅ Pass
pnpm build      # ✅ Pass
pnpm test       # ✅ Pass (if applicable)
```

### Runtime Verification
```bash
# Start server
pnpm dev

# Check status endpoint
curl http://localhost:8900/internal/cache
# Expected: {"enabled":false,"implName":"NullCache",...}

# Check metrics endpoint
curl http://localhost:8900/metrics | grep cache_
# Expected: cache_hits_total{impl="null"} 0, etc.
```

### Prometheus Queries
```promql
# Verify metrics are registered
cache_miss_total
cache_enabled
```

---

## 🔄 Next Steps

### Phase 2: Edge Cache Pilot (Next Week)
- Add Cache-Control + ETag headers middleware
- Validate with Nginx/Varnish
- 48h observation period
- **Decision point**: Hit rate >30% → Phase 3, <10% → Stop

### Phase 3: Redis Plugin (2-3 weeks, if validated)
- Migrate code from PR #144 to plugin structure
- Feature flag: FEATURE_CACHE_REDIS
- Canary deployment: 10% → 50% → 100%
- Auto-degrade to NullCache on Redis failure

---

## 📚 Related

- **Decision**: `claudedocs/CACHE_ARCHITECTURE_DECISION_20251103.md`
- **Full Plan**: `claudedocs/CACHE_3PHASE_IMPLEMENTATION_PLAN.md`
- **Origin PR**: #144 (closed, value preserved)
- **Session**: `claudedocs/SESSION_SUMMARY_20251103.md`

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)" \
  --base main
```

#### 12.3 启用auto-merge

```bash
gh pr merge --auto --squash [PR_NUMBER]
```

---

## ✅ 验收标准

### 代码质量
- [ ] 所有文件TypeScript typecheck通过
- [ ] Build成功无错误
- [ ] 无ESLint warnings (如有linter)
- [ ] 代码格式一致

### 功能验证
- [ ] /internal/cache返回正确状态
- [ ] Prometheus显示所有cache_* metrics
- [ ] NullCache所有方法正常工作
- [ ] CacheRegistry单例工作正常

### 文档完整
- [ ] TSDoc注释完整
- [ ] .env.example已更新
- [ ] PR description详细
- [ ] Commit message规范

### 零影响确认
- [ ] 无生产行为变更
- [ ] 无新依赖引入
- [ ] 无性能影响
- [ ] 向后兼容

---

## 🚨 潜在问题排查

### 问题1: metrics对象导出方式不明确

**检查**:
```bash
grep -n "export.*metrics" src/metrics/metrics.ts
```

**可能情况**:
- `export const metrics = {...}`
- `export default {...}`
- `module.exports = {...}`

**解决**: 根据实际导出方式调整import

---

### 问题2: internal.ts不存在

**检查**:
```bash
ls -la src/routes/internal.ts
```

**如果不存在**:
1. 创建新文件
2. 在src/index.ts中注册路由：
   ```typescript
   import internalRouter from './routes/internal'
   app.use('/internal', internalRouter)
   ```

---

### 问题3: TypeScript配置问题

**检查tsconfig.json**:
```bash
cat tsconfig.json | jq '.compilerOptions.paths'
```

**可能需要添加**:
```json
{
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
```

---

### 问题4: Prometheus client版本

**检查**:
```bash
grep "prom-client" package.json
```

**如果版本<14.0**:
- Counter/Gauge API可能不同
- 参考官方文档调整

---

## 📝 时间记录

| 步骤 | 预计时间 | 实际时间 | 备注 |
|------|---------|---------|------|
| 1. Feature branch | 5m | | |
| 2. Cache接口 | 15m | | |
| 3. NullCache | 20m | | |
| 4. CacheRegistry | 30m | | |
| 5. Metrics | 20m | | |
| 6. /internal/cache | 20m | | |
| 7. Core集成 | 20m | | |
| 8. 环境变量 | 5m | | |
| 9. 构建测试 | 15m | | |
| 10. Runtime验证 | 15m | | |
| 11. Commit | 10m | | |
| 12. PR创建 | 10m | | |
| **总计** | **2h 45m** | | |

---

## 🎯 成功标志

**Phase 1完成标志**:
- ✅ PR创建并通过CI
- ✅ Auto-merge启用
- ✅ 所有验收标准满足
- ✅ 文档完整
- ✅ Zero production impact confirmed

**准备Phase 2标志**:
- ✅ Phase 1 PR已合并
- ✅ Metrics正常收集数据
- ✅ /internal/cache可用
- ✅ Team ready for Phase 2

---

**检查清单创建**: 2025-11-03 12:00 CST
**预计开始**: PR #346合并后
**预计完成**: 开始后2.5-3小时

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
