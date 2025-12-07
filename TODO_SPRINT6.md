# Sprint 6 执行 Checklist: 多租户分片与可靠性增强 (Phase 11 & Reliability)

**Sprint 周期**: 2025-12-15 ~ 2025-12-19
**状态**: ✅ 已完成 (Day 1-5 全部完成)

---

## 📋 每日进度追踪

### Day 1: 多连接池管理器 (Multi-Pool Manager) ✅ 已完成
- [x] 扩展 `PoolManager` 支持动态多实例管理
  - 实现: `ShardedPoolManager` (`src/db/sharding/sharded-pool-manager.ts`)
- [x] 实现基于配置的分片初始化 (`shard-0` -> `db_host_1`)
  - 支持环境变量配置: `SHARD_0_URL`, `SHARD_1_URL`, etc.
- [x] 单元测试: 验证 `get(shardId)` 返回正确连接池实例
  - 23 个测试通过 (`sharded-pool-manager.test.ts`)

**关键实现**:
- `ShardedPoolManager`: 多分片连接池管理
- `getPoolForTenant()`: 根据租户路由到正确分片
- `queryForTenant()` / `transactionForTenant()`: 分片感知的数据库操作
- 健康检查与指标: `db_shard_total_connections`, `db_shard_healthy`

### Day 2: 分片路由集成 (Sharded Routing) ✅ 已完成
- [x] 在 `MessageBus` 中集成 `ShardingStrategy`
  - 实现: `MessageShardInterceptor` (`src/db/sharding/message-shard-interceptor.ts`)
- [x] 实现消息拦截器: 提取 `x-tenant-id` 并计算分片 Key
  - 实现: `extractTenantFromHeaders()`, `TenantContextStorage` (AsyncLocalStorage)
- [x] 实现路由逻辑: 将 DB 操作导向正确的分片连接池
  - 实现: `tenantContext.runAsync()` 自动路由
- [x] 验证: 模拟多租户数据落入不同虚拟池
  - 34 个测试通过 (`shard-routing.test.ts`)

**关键实现**:
- `TenantContextStorage`: AsyncLocalStorage 上下文传播
- `MessageShardInterceptor.wrap()`: 消息处理器包装器
- `createTenantAwareHandler()`: 便捷租户感知处理器创建
- 系统主题排除: `__rpc.reply.*`, `system.*`, `health.*`

### Day 3: RPC 可靠性修复 (Tech Debt) ✅ 已完成
- [x] 修复 `request()` 超时未清理订阅的内存泄漏问题
  - 修复: `PendingRpc.cleanup` 回调，统一清理逻辑
- [x] 新增指标 `rpc_active_correlations` (Gauge)
  - 实现: 在 `request()` 开始/结束时更新
- [x] 验证: 模拟超时场景，确认订阅数回归正常
  - 10 个新测试通过 (`message-bus-integration.test.ts`)

**关键修复**:
- `request()`: 添加集中式 `cleanup()` 函数
- `processQueue()`: "No subscriber" 路径调用 cleanup
- `handleMessageError()`: DLQ 后调用 cleanup
- `shutdown()`: 所有 pending RPC 调用 cleanup

**测试总数**: 672 个测试通过 (Sprint 5: 663)

### Day 4: 速率限制 (Rate Limiting) ✅ 已完成
- [x] 实现 `TokenBucketRateLimiter`
  - 实现: `TokenBucketRateLimiter` (`src/integration/rate-limiting/token-bucket.ts`)
- [x] 集成到 `MessageBus` (基于租户 ID 限流)
  - 实现: `MessageRateLimiter` (`src/integration/rate-limiting/message-rate-limiter.ts`)
- [x] 配置: 默认每租户 1000 msg/s
  - 可配置: `tokensPerSecond`, `bucketCapacity` (默认 2 秒爆发容量)
- [x] 验证: 压力测试触发限流拦截
  - 36 个新测试通过 (`rate-limiting.test.ts`)

**关键实现**:
- `TokenBucketRateLimiter`: 经典令牌桶算法实现
  - Token 按速率自动补充
  - 支持爆发容量 (burst allowance)
  - 自动清理空闲桶 (5 分钟超时)
- `MessageRateLimiter`: MessageBus 集成
  - `wrap()`: 消息处理器包装器
  - 基于 `x-tenant-id` 提取限流 Key
  - 支持自定义 `keyExtractor`
  - 系统主题排除: `__rpc.reply.*`, `system.*`, `health.*`
- `RateLimitError`: 限流异常，包含 `retryAfterMs`
- `createRateLimitedHandler()`: 便捷速率限制处理器创建
- 指标: `rate_limit_allowed`, `rate_limit_rejected`, `rate_limit_active_buckets`

**测试总数**: 708 个测试通过 (Day 3: 672)

### Day 5: 分片端到端验证 (E2E Verification) ✅ 已完成
- [x] 编写集成测试: 模拟 2 个物理分片环境
  - 实现: `sharding-e2e.test.ts` (`src/tests/sharding-e2e.test.ts`)
- [x] 验证租户隔离性 (Tenant A -> Shard 1, Tenant B -> Shard 2)
  - 测试: 物理分片隔离、并发操作、上下文传播
- [x] 验证: 17 个新测试通过 (`sharding-e2e.test.ts`)

**关键实现**:
- `Physical Shard Isolation`: 验证不同租户路由到不同分片
- `MessageBus Integration`: 消息处理器中的分片路由验证
- `Tenant Context Propagation`: AsyncLocalStorage 上下文传播测试
- `Shard Distribution Analysis`: 哈希分布均匀性分析
- `Error Handling and Resilience`: 错误处理与弹性测试
- `Metrics and Observability`: 指标采集验证

**测试总数**: 725 个测试通过 (Day 4: 708)

---

## ✅ 核心完成标准

### 1. 物理隔离
- [x] 不同租户的数据操作被正确路由到不同的数据库连接池
- [x] 无租户 ID 的操作默认路由到 `default` 分片

### 2. 系统可靠性
- [x] RPC 超时后，相关订阅被立即清理 (无内存泄漏)
- [x] 突发流量下，RateLimiter 能有效保护后端

### 3. 可观测性
- [x] 新增分片路由指标 (`shard_routed_messages`, `shard_routing_errors`, `shard_routing_duration_ms`)
- [x] 新增 RPC 活跃数指标 (`rpc_active_correlations`)
