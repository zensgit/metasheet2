import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock ioredis BEFORE importing modules that reference it.
// vi.mock is hoisted - the factory must be completely self-contained.
// ---------------------------------------------------------------------------

vi.mock('ioredis', async () => {
  const { EventEmitter } = await import('events')

  class MockRedis extends EventEmitter {
    status = 'ready'
    _store = new Map<string, { value: string; expiresAt?: number }>()
    _shouldFail = false

    constructor() {
      super()
      const g = globalThis as Record<string, unknown>
      g.__mockRedisInstances = g.__mockRedisInstances || []
      ;(g.__mockRedisInstances as unknown[]).push(this)

      queueMicrotask(() => {
        this.emit('connect')
        this.emit('ready')
      })
    }

    async get(key: string): Promise<string | null> {
      if (this._shouldFail) throw new Error('Redis connection lost')
      const entry = this._store.get(key)
      if (!entry) return null
      if (entry.expiresAt && Date.now() >= entry.expiresAt) {
        this._store.delete(key)
        return null
      }
      return entry.value
    }

    async set(key: string, value: string, ...args: unknown[]): Promise<string | null> {
      if (this._shouldFail) throw new Error('Redis connection lost')
      let ttlMs: number | undefined
      for (let i = 0; i < args.length; i++) {
        if (args[i] === 'EX' && typeof args[i + 1] === 'number') {
          ttlMs = (args[i + 1] as number) * 1000
        }
      }
      const isNX = args.includes('NX')
      if (isNX && this._store.has(key)) {
        const existing = this._store.get(key)!
        if (!existing.expiresAt || Date.now() < existing.expiresAt) {
          return null
        }
      }
      this._store.set(key, {
        value,
        expiresAt: ttlMs ? Date.now() + ttlMs : undefined
      })
      return 'OK'
    }

    async del(key: string): Promise<number> {
      if (this._shouldFail) throw new Error('Redis connection lost')
      return this._store.delete(key) ? 1 : 0
    }

    simulateDisconnect(): void {
      this._shouldFail = true
      this.status = 'end'
      this.emit('error', new Error('Connection lost'))
      this.emit('end')
    }

    simulateReconnect(): void {
      this._shouldFail = false
      this.status = 'ready'
      this.emit('connect')
      this.emit('ready')
    }
  }

  return { default: MockRedis }
})

// Mock logger
vi.mock('../../src/core/logger', () => ({
  Logger: class {
    info() { /* noop */ }
    warn() { /* noop */ }
    debug() { /* noop */ }
    error() { /* noop */ }
  }
}))

// Mock safety-metrics
vi.mock('../../src/guards/safety-metrics', () => ({
  recordIdempotencyHit: vi.fn(),
  recordIdempotencyMiss: vi.fn(),
  recordRateLimitExceeded: vi.fn(),
  recordMessageDedupHit: vi.fn(),
  recordEventReplaySkipped: vi.fn()
}))

// Mock prom-client
vi.mock('prom-client', () => ({
  default: {
    Counter: class { inc() { /* noop */ } },
    Gauge: class { set() { /* noop */ } },
    Histogram: class { observe() { /* noop */ } },
    Summary: class { observe() { /* noop */ } },
    Registry: class { registerMetric() { /* noop */ } }
  },
  Counter: class { inc() { /* noop */ } },
  Registry: class { registerMetric() { /* noop */ } }
}))

// Mock metrics registry
vi.mock('../../src/metrics/metrics', () => ({
  registry: { registerMetric: vi.fn() }
}))

// ---------------------------------------------------------------------------
// Import modules under test AFTER mocks
// ---------------------------------------------------------------------------

import {
  initIdempotency,
  destroyIdempotency,
  getActiveStore
} from '../../src/guards/idempotency'

import { MessageDeduplicator } from '../../src/integration/messaging/message-bus'

// Helper to get the last MockRedis instance
function getLastMockRedis(): Record<string, unknown> {
  const g = globalThis as Record<string, unknown>
  const instances = g.__mockRedisInstances as unknown[]
  return instances[instances.length - 1] as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// A. Redis Idempotency Store
// ---------------------------------------------------------------------------

describe('RedisIdempotencyStore', () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).__mockRedisInstances = []
  })

  afterEach(async () => {
    await destroyIdempotency()
    delete process.env.IDEMPOTENCY_STORE
    delete process.env.REDIS_URL
  })

  it('should store and retrieve entries via Redis', async () => {
    process.env.IDEMPOTENCY_STORE = 'redis'
    process.env.REDIS_URL = 'redis://localhost:6379'
    initIdempotency({ ttlSeconds: 60 })
    await new Promise(resolve => setTimeout(resolve, 10))

    const store = getActiveStore()
    const entry = {
      response: { statusCode: 200, body: { ok: true } },
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000)
    }

    await store.set('user1:key1', entry, 60)
    const result = await store.get('user1:key1')

    expect(result).toBeDefined()
    expect(result!.response.statusCode).toBe(200)
    expect(result!.response.body).toEqual({ ok: true })
  })

  it('should fall back to memory when Redis is down', async () => {
    process.env.IDEMPOTENCY_STORE = 'redis'
    process.env.REDIS_URL = 'redis://localhost:6379'
    initIdempotency({ ttlSeconds: 60 })
    await new Promise(resolve => setTimeout(resolve, 10))

    const store = getActiveStore()
    const mockRedis = getLastMockRedis()

    const entry = {
      response: { statusCode: 201, body: { id: 'abc' } },
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000)
    }

    await store.set('user1:key2', entry, 60)

    // Simulate Redis going down
    ;(mockRedis as { simulateDisconnect: () => void }).simulateDisconnect()

    // Should still retrieve from memory fallback
    const result = await store.get('user1:key2')
    expect(result).toBeDefined()
    expect(result!.response.statusCode).toBe(201)
  })

  it('should return undefined for missing keys', async () => {
    process.env.IDEMPOTENCY_STORE = 'redis'
    process.env.REDIS_URL = 'redis://localhost:6379'
    initIdempotency({ ttlSeconds: 60 })
    await new Promise(resolve => setTimeout(resolve, 10))

    const store = getActiveStore()
    const result = await store.get('nonexistent')
    expect(result).toBeUndefined()
  })

  it('should default to memory store when IDEMPOTENCY_STORE is not set', async () => {
    initIdempotency({ ttlSeconds: 60 })

    const store = getActiveStore()
    const entry = {
      response: { statusCode: 200, body: null },
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000)
    }

    await store.set('u:k', entry, 60)
    const result = await store.get('u:k')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// B. Message Deduplicator
// ---------------------------------------------------------------------------

describe('MessageDeduplicator', () => {
  it('should detect duplicate messages (memory-only)', async () => {
    const dedup = new MessageDeduplicator({ ttlSeconds: 60 })

    const first = await dedup.isDuplicate('msg_001')
    expect(first).toBe(false)

    const second = await dedup.isDuplicate('msg_001')
    expect(second).toBe(true)
  })

  it('should detect duplicate messages via Redis', async () => {
    const Redis = (await import('ioredis')).default
    const redis = new Redis()
    await new Promise(resolve => setTimeout(resolve, 10))

    const dedup = new MessageDeduplicator({
      redis: redis as unknown as import('ioredis').default,
      ttlSeconds: 60
    })

    const first = await dedup.isDuplicate('msg_r1')
    expect(first).toBe(false)

    const second = await dedup.isDuplicate('msg_r1')
    expect(second).toBe(true)
  })

  it('should fall back to memory when Redis goes down', async () => {
    const Redis = (await import('ioredis')).default
    const redis = new Redis()
    await new Promise(resolve => setTimeout(resolve, 10))

    const dedup = new MessageDeduplicator({
      redis: redis as unknown as import('ioredis').default,
      ttlSeconds: 60
    })

    await dedup.isDuplicate('msg_f1')

    // Disconnect Redis
    ;(redis as unknown as { simulateDisconnect: () => void }).simulateDisconnect()

    const isDup = await dedup.isDuplicate('msg_f2')
    expect(isDup).toBe(false)

    const isDup2 = await dedup.isDuplicate('msg_f2')
    expect(isDup2).toBe(true)
  })

  it('should respect LRU capacity limit', async () => {
    const dedup = new MessageDeduplicator({
      maxMemoryEntries: 3,
      ttlSeconds: 60
    })

    await dedup.isDuplicate('a')
    await dedup.isDuplicate('b')
    await dedup.isDuplicate('c')
    expect(dedup.memoryCacheSize).toBe(3)

    await dedup.isDuplicate('d')
    expect(dedup.memoryCacheSize).toBe(3)

    // 'a' was evicted, so it should not be a duplicate
    const isDup = await dedup.isDuplicate('a')
    expect(isDup).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// C. Event Replay Idempotency
// ---------------------------------------------------------------------------

describe('Event Replay Idempotency', () => {
  it('should expose replaySkippedCount getter', async () => {
    vi.doMock('../../src/db/db', () => ({
      db: {
        selectFrom: () => ({
          selectAll: () => ({
            where: () => ({
              where: () => ({
                where: () => ({
                  limit: () => ({ execute: async () => [] })
                })
              }),
              orderBy: () => ({ execute: async () => [] })
            }),
            orderBy: () => ({ execute: async () => [] }),
            execute: async () => []
          }),
          select: () => ({
            where: () => ({
              where: () => ({
                where: () => ({
                  limit: () => ({ execute: async () => [] })
                })
              })
            })
          })
        }),
        insertInto: () => ({
          values: () => ({
            execute: async () => ({}),
            onConflict: () => ({
              column: () => ({
                doUpdateSet: () => ({ execute: async () => ({}) })
              })
            })
          })
        }),
        updateTable: () => ({
          set: () => ({
            where: () => ({ execute: async () => ({}) })
          })
        })
      }
    }))

    vi.doMock('kysely', () => ({
      sql: { raw: () => ({}) }
    }))

    vi.doMock('ajv', () => ({
      default: class { compile() { return () => true } }
    }))

    const { EventBusService } = await import('../../src/core/EventBusService')
    const service = new EventBusService()

    expect(service.getReplaySkippedCount()).toBe(0)
  })
})
