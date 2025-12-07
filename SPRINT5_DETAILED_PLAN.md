# Sprint 5 详细开发计划: 性能与扩展性优化 (Phase 11)

**Sprint 周期**: 2025-12-08 ~ 2025-12-12
**目标**: 将消息总线匹配性能提升 10 倍，并建立数据库连接池与分片的基础设施。

---

## 📅 每日执行计划

### Day 1: 模式匹配引擎升级 (PatternTrie Integration)
**目标**: 替换 `MessageBus` 中的 O(N) 线性扫描为 O(log N) Trie 匹配，同时保持向后兼容。

- [ ] **Step 1.1: 接口适配与扩展**
  - 定义 `MessageBusSubscription` 接口，扩展原 `Subscription` 以支持 `plugin` 字段（用于生命周期管理）。
  - 修改 `PatternManager.subscribe` 签名以接受 `plugin` 参数。
- [ ] **Step 1.2: 集成到 MessageBus (带 Feature Flag)**
  - 在 `MessageBus` 中引入 `PatternManager` 实例。
  - 实现 `ENABLE_PATTERN_TRIE` 开关，允许在旧版正则数组和新版 Trie 之间切换（回滚保障）。
  - 替换 `subscribePattern`、`unsubscribe` 等核心方法。
- [ ] **Step 1.3: 优化 processQueue**
  - 重构 `processQueue`，在 Feature Flag 开启时使用 `PatternManager.findMatches(topic)`。
- [ ] **Step 1.4: 验证测试**
  - 扩展 `message-bus.test.ts`，增加针对 Trie 匹配的测试用例。
  - 验证 `plugin` 字段在 Trie 模式下能正确用于 `unsubscribeByPlugin`。

### Day 2: 热点缓存与性能调优 (LRU Cache)
**目标**: 减少高频 Topic 的 Trie 遍历开销，增加 TTL 支持。

- [ ] **Step 2.1: 增强 LRU Cache**
  - 修改 `PatternManager` 中的 `LRUCache`，增加 `TTL` (Time To Live) 支持。
  - 配置接口增加 `ttlMs` 选项。
- [ ] **Step 2.2: 缓存失效策略**
  - 验证 `subscribe/unsubscribe` 操作触发 `invalidateCache()`。
  - 确保过期条目在访问时自动清理。
- [ ] **Step 2.3: 性能指标埋点**
  - 确保 `pattern_match_cache_hit` 和 `pattern_match_duration` 指标正确上报。

### Day 3: 数据库连接池优化 (Connection Pool)
**目标**: 优化高并发下的数据库连接管理，并实现可视化监控。

- [ ] **Step 3.1: Prometheus 指标集成**
  - 在 `ConnectionPool.ts` 中实现指标收集。
  - 注册 Prometheus Gauge: `db_pool_waiting_clients`, `db_pool_active_connections`, `db_pool_total_connections`。
- [ ] **Step 3.2: 配置调优**
  - 基于 Sprint 4 压测数据，调整 `DB_POOL_MAX` 和 `DB_IDLE_TIMEOUT`。
- [ ] **Step 3.3: 压力测试与监控验证**
  - 使用 `autocannon` 模拟并发，验证 Grafana 面板能否正确显示连接池状态。

### Day 4: 租户分片策略 MVP (Sharding)
**目标**: 定义分片架构标准，暂不进行实际流量路由（降低风险）。

- [ ] **Step 4.1: 定义分片接口**
  - 创建 `ShardingStrategy` 接口：`getShardKey(tenantId)`, `getDatabaseUrl(shardKey)`。
- [ ] **Step 4.2: 实现哈希分片算法**
  - 实现 `TenantHashShardingStrategy` (一致性哈希或取模)。
- [ ] **Step 4.3: 单元测试**
  - 编写单元测试验证分片键生成的均匀性和稳定性。
  - *注：实际的消息路由集成推迟到 Sprint 6。*

### Day 5: 综合基准测试 (Benchmarking)
**目标**: 建立性能基线，验证 10 倍提升目标。

- [ ] **Step 5.1: 编写专项基准测试**
  - 创建 `benchmark/pattern-matching.ts`。
  - 场景：10,000 个 Pattern 订阅，1,000,000 次消息发送。
  - 对比组：旧版 Regex 数组 vs 新版 PatternTrie。
- [ ] **Step 5.2: 执行对比测试**
  - 记录 CPU、内存、延迟 (P99) 变化。
- [ ] **Step 5.3: 生成报告**
  - 更新 `PERFORMANCE_REPORT.md`，包含具体的性能对比数据。

---

## 🛠 技术细节

### PatternManager 适配方案

```typescript
// 适配接口
interface MessageBusSubscription extends Subscription {
  plugin?: string; // 用于插件生命周期管理
}

// MessageBus 集成
class MessageBus {
  private patternManager: PatternManager;
  private useTrie: boolean = process.env.ENABLE_PATTERN_TRIE === 'true';

  // ...
}
```

### 关键指标 (Metrics)

| 指标名称 | 类型 | 说明 |
|---------|------|------|
| `pattern_match_duration_seconds` | Histogram | 匹配耗时分布 |
| `pattern_cache_hit_total` | Counter | 缓存命中次数 |
| `db_pool_waiting_clients` | Gauge | 等待连接的请求数 |
| `db_pool_active_connections` | Gauge | 当前活跃连接数 |

---

## ⚠️ 风险与缓解

1.  **架构不兼容**: `PatternManager` 缺少 `plugin` 字段支持。
    *   *缓解*: Day 1 优先完成接口适配器，确保不破坏现有插件机制。
2.  **缓存陈旧**: 无 TTL 可能导致内存泄漏或陈旧数据。
    *   *缓解*: Day 2 必须实现 TTL 自动过期机制。
3.  **过度设计**: 分片路由在当前阶段可能引入不必要的复杂性。
    *   *缓解*: Day 4 仅完成接口定义和算法实现，不触碰核心路由逻辑。
