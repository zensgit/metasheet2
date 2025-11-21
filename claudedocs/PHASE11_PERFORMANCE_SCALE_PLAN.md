# Phase 11: Performance & Scale 规划文档

**文档版本**: 1.0.0
**创建日期**: 2025-11-16
**状态**: 规划中

---

## 📋 概述

Phase 11 聚焦系统性能优化和可扩展性提升：

- **Event Pattern 索引优化**: 替换线性扫描，使用 Trie/Bucket 结构
- **数据分片策略**: 支持按租户/命名空间分片
- **基准测试和压测**: 建立性能基线和极限测试

---

## 🎯 性能目标

| 指标 | 当前值 | 目标值 | 提升倍数 |
|------|--------|--------|----------|
| **Pattern 匹配延迟** | O(n) 线性 | O(log n) | 10x |
| **最大订阅数量** | 1,000 | 10,000 | 10x |
| **消息吞吐量** | 1,000 msg/s | 10,000 msg/s | 10x |
| **P99 延迟** | < 100ms | < 50ms | 2x |
| **内存占用** | 基线 | < 2x 基线 | - |

---

## 🏗️ 核心优化方案

### 1. Event Pattern 索引优化

#### 当前问题

```typescript
// 当前实现: 线性扫描 O(n)
for (const [pattern, handlers] of this.patternSubscriptions) {
  if (this.matchPattern(eventName, pattern)) {
    handlers.forEach(handler => handler(event))
  }
}
```

**问题**: 当 patternSubscriptions 达到 1000+ 时，性能显著下降。

#### 优化方案 A: Prefix Bucket

```typescript
class PrefixBucketIndex {
  // 按前缀分桶: { "user.*": [...], "order.*": [...] }
  private buckets: Map<string, PatternHandler[]> = new Map()
  private prefixLength: number = 3  // 可配置

  addPattern(pattern: string, handler: PatternHandler): void {
    const prefix = this.extractPrefix(pattern)
    if (!this.buckets.has(prefix)) {
      this.buckets.set(prefix, [])
    }
    this.buckets.get(prefix)!.push({ pattern, handler })
  }

  match(eventName: string): PatternHandler[] {
    const prefix = eventName.substring(0, this.prefixLength)
    const candidates = this.buckets.get(prefix) || []

    // 只在候选集中匹配
    return candidates.filter(c => this.matchPattern(eventName, c.pattern))
  }

  private extractPrefix(pattern: string): string {
    // "user.*" -> "use"
    // "user.created" -> "use"
    return pattern.replace(/\*/g, '').substring(0, this.prefixLength)
  }
}
```

**性能**: O(n/k)，k 为桶数量

#### 优化方案 B: Trie 结构

```typescript
class PatternTrie {
  private root: TrieNode = { children: new Map(), handlers: [] }

  insert(pattern: string, handler: PatternHandler): void {
    const segments = pattern.split('.')
    let node = this.root

    for (const segment of segments) {
      if (!node.children.has(segment)) {
        node.children.set(segment, { children: new Map(), handlers: [] })
      }
      node = node.children.get(segment)!
    }

    node.handlers.push(handler)
  }

  match(eventName: string): PatternHandler[] {
    const segments = eventName.split('.')
    return this.matchRecursive(this.root, segments, 0)
  }

  private matchRecursive(
    node: TrieNode,
    segments: string[],
    index: number
  ): PatternHandler[] {
    if (index === segments.length) {
      return node.handlers
    }

    const segment = segments[index]
    const results: PatternHandler[] = []

    // 精确匹配
    if (node.children.has(segment)) {
      results.push(...this.matchRecursive(node.children.get(segment)!, segments, index + 1))
    }

    // 通配符匹配
    if (node.children.has('*')) {
      results.push(...this.matchRecursive(node.children.get('*')!, segments, index + 1))
    }

    // 多级通配符 **
    if (node.children.has('**')) {
      // 匹配 0 个或多个 segments
      for (let i = index; i <= segments.length; i++) {
        results.push(...this.matchRecursive(node.children.get('**')!, segments, i))
      }
    }

    return results
  }
}

interface TrieNode {
  children: Map<string, TrieNode>
  handlers: PatternHandler[]
}
```

**性能**: O(m)，m 为 pattern 深度（通常 3-5）

#### 推荐方案

**混合策略**: Trie + LRU 缓存

```typescript
class OptimizedPatternMatcher {
  private trie: PatternTrie
  private cache: LRUCache<string, PatternHandler[]>

  match(eventName: string): PatternHandler[] {
    // 缓存命中
    if (this.cache.has(eventName)) {
      return this.cache.get(eventName)!
    }

    // Trie 查询
    const handlers = this.trie.match(eventName)
    this.cache.set(eventName, handlers)

    return handlers
  }
}
```

---

### 2. 数据分片策略

#### 分片维度

| 分片键 | 适用场景 | 复杂度 |
|--------|----------|--------|
| **Tenant ID** | 多租户 SaaS | 低 |
| **Namespace** | 功能模块隔离 | 低 |
| **Hash** | 均匀分布 | 中 |
| **Range** | 时间序列数据 | 中 |
| **Geography** | 地理分布 | 高 |

#### Tenant-Based 分片实现

```typescript
interface ShardConfig {
  strategy: 'tenant' | 'namespace' | 'hash'
  shardCount: number
  routingKey: string
}

class ShardedEventBus {
  private shards: Map<string, EventBusService> = new Map()
  private config: ShardConfig

  constructor(config: ShardConfig) {
    this.config = config
    // 初始化分片
    for (let i = 0; i < config.shardCount; i++) {
      this.shards.set(`shard_${i}`, new EventBusService())
    }
  }

  async emit(event: Event, context: EventContext): Promise<void> {
    const shardKey = this.calculateShardKey(context)
    const shard = this.getShard(shardKey)

    await shard.emit(event.name, event.payload, context)
  }

  private calculateShardKey(context: EventContext): string {
    switch (this.config.strategy) {
      case 'tenant':
        return context.tenantId || 'default'

      case 'namespace':
        return context.namespace || 'global'

      case 'hash':
        const key = context[this.config.routingKey] || ''
        return `shard_${this.hashCode(key) % this.config.shardCount}`
    }
  }

  private getShard(key: string): EventBusService {
    // 一致性哈希或直接映射
    if (this.shards.has(key)) {
      return this.shards.get(key)!
    }
    // 默认分片
    return this.shards.get('shard_0')!
  }

  private hashCode(str: string): number {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i)
      hash |= 0
    }
    return Math.abs(hash)
  }
}
```

#### 消息队列分片

```typescript
class ShardedMessageQueue {
  private queues: Map<string, PriorityQueue> = new Map()

  enqueue(message: Message, shardKey: string): void {
    if (!this.queues.has(shardKey)) {
      this.queues.set(shardKey, new PriorityQueue())
    }
    this.queues.get(shardKey)!.enqueue(message)
  }

  // 并行处理多个分片
  async processAllShards(concurrency: number = 4): Promise<void> {
    const shardKeys = Array.from(this.queues.keys())

    await pLimit(concurrency, shardKeys.map(key =>
      () => this.processShard(key)
    ))
  }
}
```

---

### 3. 基准测试和压测

#### 基准测试脚本

```typescript
// scripts/benchmark.ts
import { EventBusService } from '../src/core/EventBusService'
import { performance } from 'perf_hooks'

interface BenchmarkResult {
  testName: string
  operations: number
  durationMs: number
  opsPerSecond: number
  p50: number
  p95: number
  p99: number
}

class EventBusBenchmark {
  private eventBus: EventBusService
  private latencies: number[] = []

  async runPatternMatchingBenchmark(
    patternCount: number,
    eventCount: number
  ): Promise<BenchmarkResult> {
    // 注册 patterns
    for (let i = 0; i < patternCount; i++) {
      const pattern = `domain${i % 10}.action${i % 100}.*`
      this.eventBus.subscribe(pattern, () => {})
    }

    this.latencies = []
    const start = performance.now()

    // 发送 events
    for (let i = 0; i < eventCount; i++) {
      const eventName = `domain${i % 10}.action${i % 100}.event${i}`
      const eventStart = performance.now()

      await this.eventBus.emit(eventName, { data: i })

      this.latencies.push(performance.now() - eventStart)
    }

    const duration = performance.now() - start

    return {
      testName: `Pattern Matching (${patternCount} patterns, ${eventCount} events)`,
      operations: eventCount,
      durationMs: duration,
      opsPerSecond: (eventCount / duration) * 1000,
      p50: this.percentile(50),
      p95: this.percentile(95),
      p99: this.percentile(99)
    }
  }

  async runThroughputBenchmark(
    messageCount: number,
    concurrency: number
  ): Promise<BenchmarkResult> {
    const start = performance.now()
    this.latencies = []

    // 并发发送
    const batches = []
    for (let i = 0; i < concurrency; i++) {
      batches.push(this.sendBatch(messageCount / concurrency))
    }

    await Promise.all(batches)
    const duration = performance.now() - start

    return {
      testName: `Throughput (${messageCount} messages, ${concurrency} concurrent)`,
      operations: messageCount,
      durationMs: duration,
      opsPerSecond: (messageCount / duration) * 1000,
      p50: this.percentile(50),
      p95: this.percentile(95),
      p99: this.percentile(99)
    }
  }

  private async sendBatch(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      const start = performance.now()
      await this.eventBus.emit('benchmark.test', { iteration: i })
      this.latencies.push(performance.now() - start)
    }
  }

  private percentile(p: number): number {
    const sorted = [...this.latencies].sort((a, b) => a - b)
    const index = Math.ceil((p / 100) * sorted.length) - 1
    return sorted[index] || 0
  }
}

// 运行基准测试
async function main() {
  const benchmark = new EventBusBenchmark()

  const results: BenchmarkResult[] = []

  // 测试 1: Pattern 匹配性能
  results.push(await benchmark.runPatternMatchingBenchmark(100, 10000))
  results.push(await benchmark.runPatternMatchingBenchmark(1000, 10000))
  results.push(await benchmark.runPatternMatchingBenchmark(10000, 10000))

  // 测试 2: 吞吐量
  results.push(await benchmark.runThroughputBenchmark(10000, 1))
  results.push(await benchmark.runThroughputBenchmark(10000, 10))
  results.push(await benchmark.runThroughputBenchmark(10000, 100))

  // 输出报告
  console.table(results)
}
```

#### 负载测试脚本

```typescript
// scripts/load-test.ts
import autocannon from 'autocannon'

async function runLoadTest() {
  const result = await autocannon({
    url: 'http://localhost:8900/api/events',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer <token>'
    },
    body: JSON.stringify({
      eventName: 'load.test.event',
      payload: { data: 'test' }
    }),
    connections: 100,      // 并发连接数
    duration: 60,          // 持续时间 (秒)
    pipelining: 10,        // 管道请求数
    timeout: 10            // 超时时间
  })

  console.log('Load Test Results:')
  console.log(`Requests/sec: ${result.requests.average}`)
  console.log(`Latency avg: ${result.latency.average}ms`)
  console.log(`Latency p99: ${result.latency.p99}ms`)
  console.log(`Throughput: ${result.throughput.average} bytes/sec`)
  console.log(`Errors: ${result.errors}`)
}

runLoadTest()
```

#### 性能监控仪表板

```yaml
# Grafana Dashboard 配置
panels:
  - title: "Pattern Match Latency"
    query: "histogram_quantile(0.99, rate(event_pattern_match_seconds_bucket[5m]))"

  - title: "Message Throughput"
    query: "sum(rate(metasheet_messages_processed_total[1m]))"

  - title: "Shard Distribution"
    query: "sum by (shard) (metasheet_shard_message_count)"

  - title: "Cache Hit Ratio"
    query: "sum(pattern_cache_hits) / sum(pattern_cache_total)"
```

---

## 📊 新增指标

```typescript
// Pattern 匹配性能指标
const patternMatchDuration = new Histogram({
  name: 'metasheet_pattern_match_duration_seconds',
  help: 'Pattern matching duration',
  buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1]
})

const patternCacheHits = new Counter({
  name: 'metasheet_pattern_cache_hits_total',
  help: 'Pattern cache hit count'
})

const patternCacheMisses = new Counter({
  name: 'metasheet_pattern_cache_misses_total',
  help: 'Pattern cache miss count'
})

// 分片指标
const shardMessageCount = new Counter({
  name: 'metasheet_shard_message_count',
  help: 'Messages per shard',
  labelNames: ['shard']
})

const shardLoadGauge = new Gauge({
  name: 'metasheet_shard_load',
  help: 'Current load per shard',
  labelNames: ['shard']
})

// 吞吐量指标
const messagesPerSecond = new Gauge({
  name: 'metasheet_messages_per_second',
  help: 'Current message throughput'
})
```

---

## 📅 实现计划

### 子任务分解

| 任务 | 工作量 | 依赖 | 优先级 |
|------|--------|------|--------|
| **11.1** Trie-based Pattern Matcher | 3天 | 无 | 高 |
| **11.2** LRU Cache 集成 | 1天 | 11.1 | 高 |
| **11.3** Tenant-based 分片 | 2天 | 无 | 中 |
| **11.4** 基准测试脚本 | 2天 | 11.1 | 高 |
| **11.5** 负载测试框架 | 1天 | 无 | 中 |
| **11.6** Prometheus 指标 | 1天 | 11.1-11.3 | 高 |
| **11.7** 性能优化迭代 | 3天 | 11.4-11.5 | 高 |

**总预估**: 13 天

---

## ✅ 验收标准

1. **Pattern 匹配**
   - 10,000 patterns 时延迟 < 1ms
   - 缓存命中率 > 90%
   - 无内存泄漏

2. **吞吐量**
   - 支持 10,000 msg/s
   - P99 延迟 < 50ms
   - CPU 使用率 < 80%

3. **分片**
   - 负载均衡方差 < 10%
   - 支持动态扩容
   - 无数据丢失

4. **测试覆盖**
   - 基准测试可重复运行
   - 负载测试自动化
   - CI 集成性能回归检测

---

## 🔄 回归预防

```yaml
performance_ci:
  triggers:
    - on_pr_merge
    - daily_at_midnight

  tests:
    - name: "Pattern Match Regression"
      baseline: 100μs
      threshold: 150μs  # 50% 回归阈值
      fail_on_regression: true

    - name: "Throughput Regression"
      baseline: 10000 msg/s
      threshold: 8000 msg/s
      fail_on_regression: true

  artifacts:
    - benchmark_results.json
    - flamegraph.svg
    - memory_profile.json
```

---

**🤖 Generated with [Claude Code](https://claude.com/claude-code)**
