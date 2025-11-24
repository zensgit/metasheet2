# Phase 10: Advanced Messaging 设计文档

**文档版本**: 1.0.0
**创建日期**: 2025-11-16
**状态**: 规划中

---

## 📋 概述

Phase 10 扩展 MessageBus 能力，实现企业级消息处理特性：

- **延迟投递 (Delay Scheduling)**: 支持定时/延迟消息发送
- **死信队列 (Dead Letter Queue)**: 失败消息的归档和重处理
- **重试退避 (Backoff Strategy)**: 智能重试机制，避免雪崩效应

---

## 🎯 设计目标

| 目标 | 指标 | 优先级 |
|------|------|--------|
| 延迟精度 | ±1 秒内 | 高 |
| DLQ 容量 | 10万条消息 | 中 |
| 重试成功率 | 提升 30% | 高 |
| 内存开销 | < 50MB 增量 | 中 |
| 向后兼容 | 100% | 高 |

---

## 🏗️ 架构设计

### 1. 延迟投递 (Delay Scheduling)

#### 实现方案对比

| 方案 | 优点 | 缺点 | 推荐度 |
|------|------|------|--------|
| **A: 内存定时器** | 简单、低延迟 | 重启丢失、内存占用 | ⭐⭐ |
| **B: 数据库轮询** | 持久化、可靠 | 轮询开销、延迟较高 | ⭐⭐⭐ |
| **C: Redis ZSET** | 高性能、持久化 | 额外依赖 | ⭐⭐⭐⭐⭐ |

**推荐方案**: C - Redis ZSET (可降级为 B)

#### 数据结构

```typescript
interface DelayedMessage {
  id: string
  payload: any
  topic: string
  scheduleTime: number  // Unix timestamp (ms)
  createdAt: number
  retryCount: number
  metadata: {
    source?: string
    priority?: number
    ttl?: number
  }
}
```

#### 核心实现

```typescript
class DelayScheduler {
  private redisKey = 'metasheet:delayed_messages'

  // 添加延迟消息
  async schedule(message: any, delayMs: number): Promise<string> {
    const scheduleTime = Date.now() + delayMs
    const delayedMsg: DelayedMessage = {
      id: generateId(),
      payload: message,
      topic: message.topic,
      scheduleTime,
      createdAt: Date.now(),
      retryCount: 0,
      metadata: message.metadata || {}
    }

    // Redis ZSET: score = scheduleTime
    await redis.zadd(this.redisKey, scheduleTime, JSON.stringify(delayedMsg))

    metrics.messagesDelayedTotal.inc()
    return delayedMsg.id
  }

  // 轮询到期消息
  async pollDueMessages(): Promise<DelayedMessage[]> {
    const now = Date.now()
    const messages = await redis.zrangebyscore(
      this.redisKey,
      0,
      now,
      'LIMIT', 0, 100  // 批量处理
    )

    // 原子移除已取出的消息
    if (messages.length > 0) {
      await redis.zremrangebyscore(this.redisKey, 0, now)
    }

    return messages.map(m => JSON.parse(m))
  }

  // 取消延迟消息
  async cancel(messageId: string): Promise<boolean> {
    // 扫描并移除
    const all = await redis.zrange(this.redisKey, 0, -1)
    for (const item of all) {
      const msg = JSON.parse(item)
      if (msg.id === messageId) {
        await redis.zrem(this.redisKey, item)
        return true
      }
    }
    return false
  }
}
```

#### API 设计

```typescript
// 发送延迟消息
messageBus.publishDelayed(topic, payload, {
  delayMs: 60000,  // 1分钟后
  // 或
  scheduleAt: new Date('2025-11-16T15:00:00Z')
})

// 取消延迟消息
messageBus.cancelDelayed(messageId)

// 查询待处理延迟消息
messageBus.getPendingDelayed(topic?)
```

---

### 2. 死信队列 (Dead Letter Queue)

#### DLQ 路由策略

```typescript
interface DLQPolicy {
  // 进入 DLQ 的条件
  maxRetries: number           // 最大重试次数，默认 3
  maxAge: number              // 消息最大年龄 (ms)，默认 24h
  errorTypes: string[]        // 触发 DLQ 的错误类型

  // DLQ 行为
  preserveOriginal: boolean   // 保留原始消息
  alertOnEntry: boolean       // 进入 DLQ 时告警
  autoReprocess: boolean      // 自动重处理
  reprocessDelay: number      // 重处理延迟
}
```

#### 数据库表设计

```sql
CREATE TABLE dead_letter_queue (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  original_message_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  payload JSONB NOT NULL,
  error_type TEXT NOT NULL,
  error_message TEXT,
  error_stack TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  first_failed_at TIMESTAMPTZ NOT NULL,
  last_failed_at TIMESTAMPTZ NOT NULL,
  reprocess_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending', -- pending, reprocessing, resolved, expired
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_dlq_topic ON dead_letter_queue(topic);
CREATE INDEX idx_dlq_status ON dead_letter_queue(status);
CREATE INDEX idx_dlq_error_type ON dead_letter_queue(error_type);
CREATE INDEX idx_dlq_created ON dead_letter_queue(created_at);
```

#### DLQ 服务实现

```typescript
class DeadLetterQueue {
  // 将失败消息移入 DLQ
  async enqueue(message: FailedMessage): Promise<string> {
    const dlqEntry = await db
      .insertInto('dead_letter_queue')
      .values({
        original_message_id: message.id,
        topic: message.topic,
        payload: JSON.stringify(message.payload),
        error_type: message.error.name,
        error_message: message.error.message,
        error_stack: message.error.stack,
        retry_count: message.retryCount,
        first_failed_at: message.firstFailedAt,
        last_failed_at: new Date()
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    metrics.dlqMessagesTotal.labels(message.topic, message.error.name).inc()

    if (this.policy.alertOnEntry) {
      await this.sendAlert(dlqEntry)
    }

    return dlqEntry.id
  }

  // 重处理 DLQ 消息
  async reprocess(id: string): Promise<boolean> {
    const entry = await db
      .selectFrom('dead_letter_queue')
      .where('id', '=', id)
      .selectAll()
      .executeTakeFirst()

    if (!entry || entry.status !== 'pending') {
      return false
    }

    await db
      .updateTable('dead_letter_queue')
      .set({ status: 'reprocessing', reprocess_count: entry.reprocess_count + 1 })
      .where('id', '=', id)
      .execute()

    try {
      await messageBus.publish(entry.topic, JSON.parse(entry.payload))
      await this.resolve(id, 'success')
      metrics.dlqReprocessedTotal.labels('success').inc()
      return true
    } catch (error) {
      await this.resolve(id, 'failed')
      metrics.dlqReprocessedTotal.labels('failure').inc()
      return false
    }
  }

  // 批量重处理
  async reprocessByTopic(topic: string): Promise<number> {
    const entries = await db
      .selectFrom('dead_letter_queue')
      .where('topic', '=', topic)
      .where('status', '=', 'pending')
      .selectAll()
      .execute()

    let successCount = 0
    for (const entry of entries) {
      if (await this.reprocess(entry.id)) {
        successCount++
      }
    }
    return successCount
  }

  // 清理过期 DLQ 消息
  async cleanup(maxAge: number = 7 * 24 * 3600 * 1000): Promise<number> {
    const cutoff = new Date(Date.now() - maxAge)
    const result = await db
      .deleteFrom('dead_letter_queue')
      .where('created_at', '<', cutoff)
      .where('status', '=', 'resolved')
      .execute()

    return Number(result.numDeletedRows)
  }
}
```

#### API 设计

```typescript
// 查询 DLQ
GET /api/admin/dlq?topic=...&status=pending&limit=100

// 重处理单条
POST /api/admin/dlq/:id/reprocess

// 批量重处理
POST /api/admin/dlq/reprocess-all?topic=...

// DLQ 统计
GET /api/admin/dlq/stats
```

---

### 3. 重试退避 (Backoff Strategy)

#### 退避策略类型

```typescript
type BackoffStrategy =
  | { type: 'fixed', delay: number }                    // 固定延迟
  | { type: 'linear', initial: number, increment: number }  // 线性增长
  | { type: 'exponential', initial: number, multiplier: number, maxDelay: number }  // 指数退避
  | { type: 'fibonacci', initial: number, maxDelay: number }  // 斐波那契
  | { type: 'custom', delays: number[] }                // 自定义序列
```

#### 默认策略配置

```typescript
const DEFAULT_BACKOFF_CONFIG = {
  strategy: {
    type: 'exponential',
    initial: 1000,      // 1秒
    multiplier: 2,      // 翻倍
    maxDelay: 60000     // 最大 60 秒
  },
  maxRetries: 5,
  jitter: true,         // 添加抖动避免雷鸣效应
  jitterFactor: 0.1     // 抖动范围 ±10%
}
```

#### 退避计算实现

```typescript
class BackoffCalculator {
  calculateDelay(strategy: BackoffStrategy, attempt: number): number {
    let delay: number

    switch (strategy.type) {
      case 'fixed':
        delay = strategy.delay
        break

      case 'linear':
        delay = strategy.initial + (attempt * strategy.increment)
        break

      case 'exponential':
        delay = Math.min(
          strategy.initial * Math.pow(strategy.multiplier, attempt),
          strategy.maxDelay
        )
        break

      case 'fibonacci':
        delay = Math.min(
          this.fibonacci(attempt) * strategy.initial,
          strategy.maxDelay
        )
        break

      case 'custom':
        delay = strategy.delays[Math.min(attempt, strategy.delays.length - 1)]
        break
    }

    // 添加抖动
    if (this.config.jitter) {
      const jitter = delay * this.config.jitterFactor
      delay += (Math.random() * 2 - 1) * jitter
    }

    return Math.round(delay)
  }

  private fibonacci(n: number): number {
    if (n <= 1) return n
    let a = 0, b = 1
    for (let i = 2; i <= n; i++) {
      const temp = a + b
      a = b
      b = temp
    }
    return b
  }
}
```

#### 集成到 MessageBus

```typescript
class EnhancedMessageBus extends MessageBus {
  private dlq: DeadLetterQueue
  private delayScheduler: DelayScheduler
  private backoffCalculator: BackoffCalculator

  async publishWithRetry(
    topic: string,
    payload: any,
    options: RetryOptions = {}
  ): Promise<void> {
    const config = { ...DEFAULT_BACKOFF_CONFIG, ...options }
    let attempt = 0

    while (attempt <= config.maxRetries) {
      try {
        await this.publish(topic, payload)
        metrics.messageRetrySuccessTotal.labels(String(attempt)).inc()
        return
      } catch (error) {
        attempt++

        if (attempt > config.maxRetries) {
          // 移入 DLQ
          await this.dlq.enqueue({
            id: generateId(),
            topic,
            payload,
            error: error as Error,
            retryCount: attempt,
            firstFailedAt: new Date()
          })
          throw error
        }

        // 计算退避延迟
        const delay = this.backoffCalculator.calculateDelay(config.strategy, attempt)

        metrics.messageRetryAttemptsTotal.inc()
        this.logger.warn(`Retry attempt ${attempt}/${config.maxRetries} for ${topic}, waiting ${delay}ms`)

        await this.sleep(delay)
      }
    }
  }
}
```

---

## 📊 新增指标

```typescript
// Delay Scheduling 指标
const messagesDelayedTotal = new Counter({
  name: 'metasheet_messages_delayed_total',
  help: 'Total delayed messages scheduled'
})

const messagesDelayedPending = new Gauge({
  name: 'metasheet_messages_delayed_pending',
  help: 'Current pending delayed messages'
})

// DLQ 指标
const dlqMessagesTotal = new Counter({
  name: 'metasheet_dlq_messages_total',
  help: 'Total messages sent to DLQ',
  labelNames: ['topic', 'error_type']
})

const dlqReprocessedTotal = new Counter({
  name: 'metasheet_dlq_reprocessed_total',
  help: 'Total DLQ messages reprocessed',
  labelNames: ['result']
})

const dlqPendingGauge = new Gauge({
  name: 'metasheet_dlq_pending',
  help: 'Current pending DLQ messages'
})

// Backoff 指标
const messageRetryAttemptsTotal = new Counter({
  name: 'metasheet_message_retry_attempts_total',
  help: 'Total message retry attempts'
})

const messageRetrySuccessTotal = new Counter({
  name: 'metasheet_message_retry_success_total',
  help: 'Message retries that succeeded',
  labelNames: ['attempt']
})

const backoffDelayHistogram = new Histogram({
  name: 'metasheet_backoff_delay_seconds',
  help: 'Backoff delay distribution',
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60]
})
```

---

## 🔧 配置化

```typescript
// config/messaging.ts
export const messagingConfig = {
  delay: {
    enabled: true,
    pollInterval: 1000,         // 轮询间隔
    batchSize: 100,            // 每次处理批量
    maxPendingMessages: 10000  // 最大待处理数
  },

  dlq: {
    enabled: true,
    maxRetries: 3,
    maxAge: 7 * 24 * 3600 * 1000,  // 7天
    alertOnEntry: true,
    autoCleanup: true,
    cleanupInterval: 24 * 3600 * 1000  // 每天清理
  },

  backoff: {
    strategy: 'exponential',
    initial: 1000,
    multiplier: 2,
    maxDelay: 60000,
    jitter: true
  }
}
```

---

## 📅 实现计划

### 子任务分解

| 任务 | 工作量 | 依赖 | 优先级 |
|------|--------|------|--------|
| **10.1** 延迟投递核心实现 | 2天 | Redis | 高 |
| **10.2** DLQ 数据库表和服务 | 2天 | 无 | 高 |
| **10.3** 退避策略计算器 | 1天 | 无 | 中 |
| **10.4** MessageBus 集成 | 2天 | 10.1-10.3 | 高 |
| **10.5** 管理 API 端点 | 1天 | 10.2 | 中 |
| **10.6** Prometheus 指标 | 0.5天 | 10.1-10.3 | 高 |
| **10.7** 配置化和文档 | 1天 | 全部 | 中 |

**总预估**: 9.5 天

---

## ✅ 验收标准

1. **延迟投递**
   - 延迟精度 ±1 秒
   - 支持取消延迟消息
   - 重启后延迟消息不丢失

2. **死信队列**
   - 失败消息自动进入 DLQ
   - 支持按条件重处理
   - DLQ 告警正常触发

3. **重试退避**
   - 支持多种退避策略
   - 配置化和可扩展
   - 指标正确记录

4. **性能**
   - 内存增量 < 50MB
   - 延迟投递开销 < 10ms
   - 向后兼容现有 API

---

**🤖 Generated with [Claude Code](https://claude.com/claude-code)**
