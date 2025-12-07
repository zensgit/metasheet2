/**
 * Shard Routing Tests
 * Sprint 6 Day 2: MessageBus integration for tenant-based sharding
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  tenantContext,
  extractTenantFromHeaders,
  createTenantMiddleware,
  withTenantContext
} from '../db/sharding/tenant-context'
import {
  MessageShardInterceptor,
  getMessageShardInterceptor,
  resetMessageShardInterceptor,
  createTenantAwareHandler
} from '../db/sharding/message-shard-interceptor'
import {
  ShardedPoolManager,
  resetShardedPoolManager
} from '../db/sharding/sharded-pool-manager'
import type { ShardInfo } from '../db/sharding/types'

// Mock pg Pool
vi.mock('pg', () => {
  const mockClient = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn()
  }

  const MockPool = vi.fn().mockImplementation(() => ({
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: vi.fn().mockResolvedValue(mockClient),
    end: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    totalCount: 5,
    idleCount: 3,
    waitingCount: 0
  }))

  return { Pool: MockPool }
})

// Mock metrics
vi.mock('../../integration/metrics/metrics', () => ({
  coreMetrics: {
    gauge: vi.fn(),
    increment: vi.fn(),
    histogram: vi.fn(),
    inc: vi.fn()
  }
}))

describe('TenantContext (Sprint 6 Day 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetShardedPoolManager()
    resetMessageShardInterceptor()
  })

  describe('Basic Context Operations', () => {
    it('should run function with tenant context', () => {
      const result = tenantContext.run('tenant-123', () => {
        return tenantContext.getTenantId()
      })

      expect(result).toBe('tenant-123')
    })

    it('should run async function with tenant context', async () => {
      const result = await tenantContext.runAsync('tenant-456', async () => {
        return tenantContext.getTenantId()
      })

      expect(result).toBe('tenant-456')
    })

    it('should return undefined outside tenant context', () => {
      expect(tenantContext.getTenantId()).toBeUndefined()
      expect(tenantContext.hasTenantContext()).toBe(false)
    })

    it('should indicate when in tenant context', () => {
      tenantContext.run('tenant-123', () => {
        expect(tenantContext.hasTenantContext()).toBe(true)
      })
    })

    it('should store and retrieve context metadata', () => {
      tenantContext.run('tenant-123', () => {
        const ctx = tenantContext.getContext()
        expect(ctx?.tenantId).toBe('tenant-123')
      }, { requestId: 'req-abc' })
    })

    it('should throw when requiring tenant ID outside context', () => {
      expect(() => tenantContext.requireTenantId()).toThrow('Operation requires tenant context')
    })

    it('should return tenant ID when requiring inside context', () => {
      tenantContext.run('tenant-123', () => {
        expect(tenantContext.requireTenantId()).toBe('tenant-123')
      })
    })
  })

  describe('Context with ShardedPoolManager', () => {
    let poolManager: ShardedPoolManager
    const testShards: ShardInfo[] = [
      { shardId: 'shard-0', connectionUrl: 'postgresql://localhost:5432/db0' },
      { shardId: 'shard-1', connectionUrl: 'postgresql://localhost:5433/db1' }
    ]

    beforeEach(async () => {
      poolManager = new ShardedPoolManager({ enableHealthChecks: false })
      await poolManager.initialize(testShards)
      tenantContext.setPoolManager(poolManager)
    })

    afterEach(async () => {
      await poolManager.close()
    })

    it('should pre-compute shard result when running with context', () => {
      tenantContext.run('tenant-123', () => {
        const shardResult = tenantContext.getShardResult()
        expect(shardResult).toBeDefined()
        expect(shardResult?.shardId).toBeDefined()
        expect(['shard-0', 'shard-1']).toContain(shardResult?.shardId)
      })
    })

    it('should return shard ID from context', () => {
      tenantContext.run('tenant-123', () => {
        const shardId = tenantContext.getShardId()
        expect(shardId).toBeDefined()
        expect(['shard-0', 'shard-1']).toContain(shardId)
      })
    })

    it('should consistently route same tenant to same shard', () => {
      let shardId1: string | undefined
      let shardId2: string | undefined

      tenantContext.run('consistent-tenant', () => {
        shardId1 = tenantContext.getShardId()
      })

      tenantContext.run('consistent-tenant', () => {
        shardId2 = tenantContext.getShardId()
      })

      expect(shardId1).toBe(shardId2)
    })
  })

  describe('Helper Functions', () => {
    it('should extract tenant from headers', () => {
      const headers = { 'x-tenant-id': 'tenant-abc' }
      expect(extractTenantFromHeaders(headers)).toBe('tenant-abc')
    })

    it('should extract tenant with custom header name', () => {
      const headers = { 'tenant': 'tenant-xyz' }
      expect(extractTenantFromHeaders(headers, 'tenant')).toBe('tenant-xyz')
    })

    it('should return undefined for missing headers', () => {
      expect(extractTenantFromHeaders(undefined)).toBeUndefined()
      expect(extractTenantFromHeaders({})).toBeUndefined()
    })

    it('should return undefined for empty tenant header', () => {
      expect(extractTenantFromHeaders({ 'x-tenant-id': '' })).toBeUndefined()
    })

    it('should create tenant middleware', async () => {
      const middleware = createTenantMiddleware()

      const result = await middleware('tenant-mid', async () => {
        return tenantContext.getTenantId()
      })

      expect(result).toBe('tenant-mid')
    })

    it('should wrap function with tenant context', async () => {
      const originalFn = async (x: number) => {
        return `${tenantContext.getTenantId()}-${x}`
      }

      const wrappedFn = withTenantContext('tenant-wrap', originalFn)
      const result = await wrappedFn(42)

      expect(result).toBe('tenant-wrap-42')
    })
  })
})

describe('MessageShardInterceptor (Sprint 6 Day 2)', () => {
  let interceptor: MessageShardInterceptor
  let poolManager: ShardedPoolManager

  const testShards: ShardInfo[] = [
    { shardId: 'shard-0', connectionUrl: 'postgresql://localhost:5432/db0' },
    { shardId: 'shard-1', connectionUrl: 'postgresql://localhost:5433/db1' }
  ]

  beforeEach(async () => {
    vi.clearAllMocks()
    resetShardedPoolManager()
    resetMessageShardInterceptor()

    poolManager = new ShardedPoolManager({ enableHealthChecks: false })
    await poolManager.initialize(testShards)

    interceptor = new MessageShardInterceptor({ enableMetrics: false })
    interceptor.setPoolManager(poolManager)
  })

  afterEach(async () => {
    await poolManager.close()
  })

  describe('Handler Wrapping', () => {
    it('should wrap handler and set tenant context', async () => {
      let capturedTenantId: string | undefined

      const handler = interceptor.wrap(async (msg: { headers: Record<string, unknown> }) => {
        capturedTenantId = tenantContext.getTenantId()
        return 'done'
      })

      await handler({ headers: { 'x-tenant-id': 'tenant-wrap-test' } })

      expect(capturedTenantId).toBe('tenant-wrap-test')
    })

    it('should wrap handler and set shard context', async () => {
      let capturedShardId: string | undefined

      const handler = interceptor.wrap(async (msg: { headers: Record<string, unknown> }) => {
        capturedShardId = tenantContext.getShardId()
        return 'done'
      })

      await handler({ headers: { 'x-tenant-id': 'tenant-shard-test' } })

      expect(capturedShardId).toBeDefined()
      expect(['shard-0', 'shard-1']).toContain(capturedShardId)
    })

    it('should execute without context when no tenant header', async () => {
      let hasTenantContext = false

      const handler = interceptor.wrap(async (msg: { headers: Record<string, unknown> }) => {
        hasTenantContext = tenantContext.hasTenantContext()
        return 'done'
      })

      await handler({ headers: {} })

      expect(hasTenantContext).toBe(false)
    })

    it('should throw when requireTenant is true and no header', async () => {
      const strictInterceptor = new MessageShardInterceptor({
        requireTenant: true,
        enableMetrics: false
      })
      strictInterceptor.setPoolManager(poolManager)

      const handler = strictInterceptor.wrap(async () => 'done')

      await expect(handler({ headers: {}, topic: 'test.topic' })).rejects.toThrow(
        "Missing required tenant header 'x-tenant-id'"
      )
    })

    it('should use custom header name', async () => {
      const customInterceptor = new MessageShardInterceptor({
        tenantHeaderName: 'tenant-id',
        enableMetrics: false
      })
      customInterceptor.setPoolManager(poolManager)

      let capturedTenantId: string | undefined

      const handler = customInterceptor.wrap(async (msg: { headers: Record<string, unknown> }) => {
        capturedTenantId = tenantContext.getTenantId()
        return 'done'
      })

      await handler({ headers: { 'tenant-id': 'custom-header-tenant' } })

      expect(capturedTenantId).toBe('custom-header-tenant')
    })
  })

  describe('Topic Exclusion', () => {
    it('should skip excluded topics', async () => {
      const exclusionInterceptor = new MessageShardInterceptor({
        excludeTopics: ['admin.*'],
        enableMetrics: false
      })
      exclusionInterceptor.setPoolManager(poolManager)

      let hasTenantContext = false

      const handler = exclusionInterceptor.wrap(async (msg: { topic: string; headers: Record<string, unknown> }) => {
        hasTenantContext = tenantContext.hasTenantContext()
        return 'done'
      })

      await handler({ topic: 'admin.config', headers: { 'x-tenant-id': 'tenant-123' } })

      expect(hasTenantContext).toBe(false)
    })

    it('should skip system topics by default', async () => {
      let hasTenantContext = false

      const handler = interceptor.wrap(async (msg: { topic: string; headers: Record<string, unknown> }) => {
        hasTenantContext = tenantContext.hasTenantContext()
        return 'done'
      })

      await handler({ topic: 'system.health', headers: { 'x-tenant-id': 'tenant-123' } })

      expect(hasTenantContext).toBe(false)
    })

    it('should skip RPC reply topics', async () => {
      let hasTenantContext = false

      const handler = interceptor.wrap(async (msg: { topic: string; headers: Record<string, unknown> }) => {
        hasTenantContext = tenantContext.hasTenantContext()
        return 'done'
      })

      await handler({ topic: '__rpc.reply.abc123', headers: { 'x-tenant-id': 'tenant-123' } })

      expect(hasTenantContext).toBe(false)
    })
  })

  describe('Shard Information', () => {
    it('should return shard info for tenant', () => {
      const info = interceptor.getShardInfo('tenant-info-test')

      expect(info).toBeDefined()
      expect(info?.shardId).toBeDefined()
      expect(info?.totalShards).toBe(2)
    })

    it('should return null when pool manager not configured', () => {
      const unconfiguredInterceptor = new MessageShardInterceptor({ enableMetrics: false })
      const info = unconfiguredInterceptor.getShardInfo('tenant-123')

      expect(info).toBeNull()
    })

    it('should report configuration status', () => {
      expect(interceptor.isConfigured()).toBe(true)

      const unconfiguredInterceptor = new MessageShardInterceptor({ enableMetrics: false })
      expect(unconfiguredInterceptor.isConfigured()).toBe(false)
    })
  })

  describe('Singleton Pattern', () => {
    it('should return same instance', () => {
      resetMessageShardInterceptor()
      const instance1 = getMessageShardInterceptor()
      const instance2 = getMessageShardInterceptor()

      expect(instance1).toBe(instance2)
    })

    it('should reset singleton', () => {
      const instance1 = getMessageShardInterceptor()
      resetMessageShardInterceptor()
      const instance2 = getMessageShardInterceptor()

      expect(instance1).not.toBe(instance2)
    })
  })
})

describe('createTenantAwareHandler', () => {
  let poolManager: ShardedPoolManager
  let interceptor: MessageShardInterceptor

  const testShards: ShardInfo[] = [
    { shardId: 'shard-0', connectionUrl: 'postgresql://localhost:5432/db0' },
    { shardId: 'shard-1', connectionUrl: 'postgresql://localhost:5433/db1' }
  ]

  beforeEach(async () => {
    vi.clearAllMocks()
    resetShardedPoolManager()
    resetMessageShardInterceptor()

    poolManager = new ShardedPoolManager({ enableHealthChecks: false })
    await poolManager.initialize(testShards)

    interceptor = getMessageShardInterceptor()
    interceptor.setPoolManager(poolManager)
  })

  afterEach(async () => {
    await poolManager.close()
  })

  it('should provide tenant and shard context to handler', async () => {
    interface TestMessage {
      topic: string
      headers: Record<string, unknown>
      payload: { data: string }
    }

    let receivedContext: { tenantId: string; shardId: string } | null = null

    const handler = createTenantAwareHandler<TestMessage, string>(
      async (msg, context) => {
        receivedContext = context
        return `processed for ${context.tenantId} on ${context.shardId}`
      },
      { interceptor }
    )

    const result = await handler({
      topic: 'user.created',
      headers: { 'x-tenant-id': 'tenant-aware-test' },
      payload: { data: 'test' }
    })

    expect(receivedContext).toBeDefined()
    expect(receivedContext?.tenantId).toBe('tenant-aware-test')
    expect(['shard-0', 'shard-1']).toContain(receivedContext?.shardId)
    expect(result).toContain('tenant-aware-test')
  })

  it('should throw when tenant context not available', async () => {
    const handler = createTenantAwareHandler(
      async (_msg, context) => `${context.tenantId}`,
      { interceptor }
    )

    await expect(handler({
      topic: 'test',
      headers: {},
      payload: null
    })).rejects.toThrow('Tenant context not available')
  })
})

describe('End-to-End Shard Routing', () => {
  let poolManager: ShardedPoolManager
  let interceptor: MessageShardInterceptor

  const testShards: ShardInfo[] = [
    { shardId: 'shard-0', connectionUrl: 'postgresql://localhost:5432/db0' },
    { shardId: 'shard-1', connectionUrl: 'postgresql://localhost:5433/db1' },
    { shardId: 'shard-2', connectionUrl: 'postgresql://localhost:5434/db2' }
  ]

  beforeEach(async () => {
    vi.clearAllMocks()
    resetShardedPoolManager()
    resetMessageShardInterceptor()

    poolManager = new ShardedPoolManager({ enableHealthChecks: false })
    await poolManager.initialize(testShards)

    interceptor = new MessageShardInterceptor({ enableMetrics: false })
    interceptor.setPoolManager(poolManager)
  })

  afterEach(async () => {
    await poolManager.close()
  })

  it('should consistently route tenant messages to same shard', async () => {
    const routedShards: string[] = []

    const handler = interceptor.wrap(async (msg: { headers: Record<string, unknown> }) => {
      const shardId = tenantContext.getShardId()
      if (shardId) routedShards.push(shardId)
      return 'done'
    })

    // Process 10 messages for same tenant
    for (let i = 0; i < 10; i++) {
      await handler({ headers: { 'x-tenant-id': 'consistent-tenant' } })
    }

    // All should route to same shard
    expect(new Set(routedShards).size).toBe(1)
    expect(routedShards).toHaveLength(10)
  })

  it('should distribute different tenants across shards', async () => {
    const shardDistribution: Record<string, number> = {}

    const handler = interceptor.wrap(async (msg: { headers: Record<string, unknown> }) => {
      const shardId = tenantContext.getShardId()
      if (shardId) {
        shardDistribution[shardId] = (shardDistribution[shardId] || 0) + 1
      }
      return 'done'
    })

    // Process messages for 100 different tenants
    for (let i = 0; i < 100; i++) {
      await handler({ headers: { 'x-tenant-id': `tenant-${i}` } })
    }

    // Should have distributed across multiple shards
    const usedShards = Object.keys(shardDistribution).length
    expect(usedShards).toBeGreaterThanOrEqual(2)

    // Total should be 100
    const totalRouted = Object.values(shardDistribution).reduce((a, b) => a + b, 0)
    expect(totalRouted).toBe(100)
  })

  it('should support nested tenant context for async operations', async () => {
    const results: { outer: string | undefined; inner: string | undefined }[] = []

    const outerHandler = interceptor.wrap(async (msg: { headers: Record<string, unknown> }) => {
      const outerTenant = tenantContext.getTenantId()

      // Simulate nested async operation
      await new Promise(resolve => setTimeout(resolve, 1))

      // Tenant context should be preserved
      const innerTenant = tenantContext.getTenantId()

      results.push({ outer: outerTenant, inner: innerTenant })
      return 'done'
    })

    await outerHandler({ headers: { 'x-tenant-id': 'nested-tenant' } })

    expect(results[0].outer).toBe('nested-tenant')
    expect(results[0].inner).toBe('nested-tenant')
  })
})
