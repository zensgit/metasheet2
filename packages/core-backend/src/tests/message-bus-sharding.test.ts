
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MessageBus } from '../integration/messaging/message-bus'
import { MessageShardInterceptor } from '../db/sharding/message-shard-interceptor'
import { tenantContext } from '../db/sharding/tenant-context'
import type { ShardedPoolManager } from '../db/sharding/sharded-pool-manager'

describe('MessageBus Sharding Integration (Sprint 6 Day 2)', () => {
  let messageBus: MessageBus
  let interceptor: MessageShardInterceptor
  let mockPoolManager: any

  beforeEach(() => {
    messageBus = new MessageBus({ enablePatternTrie: true })
    interceptor = new MessageShardInterceptor({
      tenantHeaderName: 'x-tenant-id',
      requireTenant: false
    })

    // Mock ShardedPoolManager
    mockPoolManager = {
      getShardForTenant: vi.fn().mockReturnValue({ shardId: 'shard-1', totalShards: 2 }),
      hasHealthyShards: vi.fn().mockReturnValue(true),
      getPoolForTenant: vi.fn()
    }

    interceptor.setPoolManager(mockPoolManager as unknown as ShardedPoolManager)
    messageBus.setInterceptor(interceptor)
  })

  afterEach(async () => {
    await messageBus.shutdown()
  })

  it('should propagate tenant context to handler', async () => {
    const handler = vi.fn().mockImplementation(async () => {
      // Check if tenant context is set
      const tenantId = tenantContext.getTenantId()
      const shardId = tenantContext.getShardId()
      return { tenantId, shardId }
    })

    messageBus.subscribe('user.created', handler)

    await messageBus.publish('user.created', { id: 1 }, {
      headers: { 'x-tenant-id': 'tenant-123' }
    })

    // Wait for async processing
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(handler).toHaveBeenCalled()
    const result = await handler.mock.results[0].value
    expect(result.tenantId).toBe('tenant-123')
    expect(result.shardId).toBe('shard-1')
  })

  it('should handle missing tenant header gracefully', async () => {
    const handler = vi.fn().mockImplementation(async () => {
      return tenantContext.getTenantId()
    })

    messageBus.subscribe('public.event', handler)

    await messageBus.publish('public.event', { id: 1 })

    await new Promise(resolve => setTimeout(resolve, 50))

    expect(handler).toHaveBeenCalled()
    const tenantId = await handler.mock.results[0].value
    expect(tenantId).toBeUndefined()
  })

  it('should work with pattern subscriptions', async () => {
    const handler = vi.fn().mockImplementation(async () => {
      return tenantContext.getTenantId()
    })

    messageBus.subscribePattern('user.*', handler)

    await messageBus.publish('user.updated', { id: 1 }, {
      headers: { 'x-tenant-id': 'tenant-456' }
    })

    await new Promise(resolve => setTimeout(resolve, 50))

    expect(handler).toHaveBeenCalled()
    const tenantId = await handler.mock.results[0].value
    expect(tenantId).toBe('tenant-456')
  })
})
