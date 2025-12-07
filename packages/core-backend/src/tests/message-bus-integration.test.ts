/**
 * MessageBus Integration Tests
 * Sprint 5: Tests for PatternTrie integration and Feature Flag functionality
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { MessageBus } from '../integration/messaging/message-bus'

// Mock external dependencies
vi.mock('../integration/metrics/metrics', () => ({
  coreMetrics: {
    inc: vi.fn(),
    increment: vi.fn(),
    histogram: vi.fn(),
    gauge: vi.fn()
  }
}))

vi.mock('../../services/DelayService', () => ({
  delayService: {
    schedule: vi.fn().mockResolvedValue('delayed_msg_123')
  }
}))

vi.mock('../../services/DeadLetterQueueService', () => ({
  dlqService: {
    enqueue: vi.fn().mockResolvedValue(undefined)
  }
}))

describe('MessageBus Integration', () => {
  let messageBus: MessageBus

  describe('PatternTrie Mode (Feature Flag Enabled)', () => {
    beforeEach(() => {
      // Ensure PatternTrie is enabled
      process.env.ENABLE_PATTERN_TRIE = 'true'
      messageBus = new MessageBus({ enablePatternTrie: true })
    })

    afterEach(async () => {
      await messageBus.shutdown()
    })

    describe('Pattern Subscription', () => {
      it('should subscribe to prefix patterns (user.*)', async () => {
        const handler = vi.fn()
        const subId = messageBus.subscribePattern('user.*', handler, 'test-plugin')

        expect(subId).toMatch(/^sub-/)

        await messageBus.publish('user.login', { userId: '123' })
        await new Promise(resolve => setTimeout(resolve, 10))

        expect(handler).toHaveBeenCalled()
      })

      it('should subscribe to suffix patterns (*.login)', async () => {
        const handler = vi.fn()
        messageBus.subscribePattern('*.login', handler)

        await messageBus.publish('user.login', { userId: '123' })
        await messageBus.publish('admin.login', { adminId: '456' })
        await new Promise(resolve => setTimeout(resolve, 10))

        expect(handler).toHaveBeenCalledTimes(2)
      })

      it('should subscribe to complex patterns (user.*.action)', async () => {
        const handler = vi.fn()
        messageBus.subscribePattern('user.*.action', handler)

        await messageBus.publish('user.profile.action', { type: 'update' })
        await messageBus.publish('user.settings.action', { type: 'change' })
        await messageBus.publish('user.action', { type: 'invalid' }) // Should NOT match
        await new Promise(resolve => setTimeout(resolve, 10))

        expect(handler).toHaveBeenCalledTimes(2)
      })

      it('should handle multiple overlapping patterns', async () => {
        const exactHandler = vi.fn()
        const prefixHandler = vi.fn()
        const suffixHandler = vi.fn()

        messageBus.subscribe('user.login', exactHandler)
        messageBus.subscribePattern('user.*', prefixHandler)
        messageBus.subscribePattern('*.login', suffixHandler)

        await messageBus.publish('user.login', { userId: '123' })
        await new Promise(resolve => setTimeout(resolve, 10))

        expect(exactHandler).toHaveBeenCalledTimes(1)
        expect(prefixHandler).toHaveBeenCalledTimes(1)
        expect(suffixHandler).toHaveBeenCalledTimes(1)
      })
    })

    describe('Plugin Lifecycle Management', () => {
      it('should track subscriptions by plugin', async () => {
        const handler1 = vi.fn()
        const handler2 = vi.fn()

        messageBus.subscribe('topic1', handler1, 'plugin-a')
        messageBus.subscribePattern('topic2.*', handler2, 'plugin-a')
        messageBus.subscribe('topic3', vi.fn(), 'plugin-b')

        const stats = messageBus.getStats()
        expect(stats.exactSubscriptions).toBe(2)
        expect(stats.patternSubscriptions).toBe(1)
      })

      it('should unsubscribe all subscriptions for a plugin', async () => {
        const handler1 = vi.fn()
        const handler2 = vi.fn()

        messageBus.subscribe('topic1', handler1, 'plugin-a')
        messageBus.subscribePattern('topic2.*', handler2, 'plugin-a')
        messageBus.subscribe('topic3', vi.fn(), 'plugin-b')

        const removedCount = messageBus.unsubscribeByPlugin('plugin-a')

        expect(removedCount).toBe(2)

        // Verify handlers are no longer called
        await messageBus.publish('topic1', { test: 'data' })
        await messageBus.publish('topic2.sub', { test: 'data' })
        await new Promise(resolve => setTimeout(resolve, 10))

        expect(handler1).not.toHaveBeenCalled()
        expect(handler2).not.toHaveBeenCalled()
      })

      it('should handle unsubscribe for non-existent plugin', () => {
        const removedCount = messageBus.unsubscribeByPlugin('non-existent')
        expect(removedCount).toBe(0)
      })
    })

    describe('Statistics and Monitoring', () => {
      it('should report PatternTrie mode in stats', () => {
        const stats = messageBus.getStats()

        expect(stats.usePatternTrie).toBe(true)
        expect(stats.patternManagerStats).toBeDefined()
        expect(stats.patternManagerStats?.trie).toBeDefined()
      })

      it('should track pattern subscriptions in stats', () => {
        messageBus.subscribePattern('user.*', vi.fn())
        messageBus.subscribePattern('order.*', vi.fn())

        const stats = messageBus.getStats()
        expect(stats.patternSubscriptions).toBe(2)
      })
    })
  })

  describe('Legacy Mode (Feature Flag Disabled)', () => {
    beforeEach(() => {
      process.env.ENABLE_PATTERN_TRIE = 'false'
      messageBus = new MessageBus({ enablePatternTrie: false })
    })

    afterEach(async () => {
      await messageBus.shutdown()
    })

    it('should use legacy regex matching', () => {
      const stats = messageBus.getStats()
      expect(stats.usePatternTrie).toBe(false)
      expect(stats.patternManagerStats).toBeUndefined()
    })

    it('should only support prefix.* patterns in legacy mode', async () => {
      const handler = vi.fn()
      messageBus.subscribePattern('user.*', handler)

      await messageBus.publish('user.login', { userId: '123' })
      await new Promise(resolve => setTimeout(resolve, 10))

      expect(handler).toHaveBeenCalled()
    })

    it('should reject complex patterns in legacy mode', () => {
      expect(() => {
        messageBus.subscribePattern('user.*.action', vi.fn())
      }).toThrow('Only single trailing prefix.* supported')

      expect(() => {
        messageBus.subscribePattern('*.login', vi.fn())
      }).toThrow('Only single trailing prefix.* supported')
    })

    it('should reject standalone wildcard', () => {
      expect(() => {
        messageBus.subscribePattern('*', vi.fn())
      }).toThrow('Wildcard "*" alone not supported')
    })

    it('should track plugin subscriptions in legacy mode', () => {
      messageBus.subscribePattern('user.*', vi.fn(), 'test-plugin')

      const removedCount = messageBus.unsubscribeByPlugin('test-plugin')
      expect(removedCount).toBe(1)
    })
  })

  describe('Mixed Subscriptions (Exact + Pattern)', () => {
    beforeEach(() => {
      messageBus = new MessageBus({ enablePatternTrie: true })
    })

    afterEach(async () => {
      await messageBus.shutdown()
    })

    it('should handle exact and pattern subscriptions together', async () => {
      const exactHandler = vi.fn()
      const patternHandler = vi.fn()

      messageBus.subscribe('user.login', exactHandler)
      messageBus.subscribePattern('user.*', patternHandler)

      await messageBus.publish('user.login', { userId: '123' })
      await new Promise(resolve => setTimeout(resolve, 10))

      expect(exactHandler).toHaveBeenCalledTimes(1)
      expect(patternHandler).toHaveBeenCalledTimes(1)
    })

    it('should correctly unsubscribe exact subscriptions', async () => {
      const handler = vi.fn()
      const subId = messageBus.subscribe('user.login', handler)

      const removed = messageBus.unsubscribe(subId)
      expect(removed).toBe(true)

      await messageBus.publish('user.login', { userId: '123' })
      await new Promise(resolve => setTimeout(resolve, 10))

      expect(handler).not.toHaveBeenCalled()
    })

    it('should correctly unsubscribe pattern subscriptions', async () => {
      const handler = vi.fn()
      const subId = messageBus.subscribePattern('user.*', handler)

      const removed = messageBus.unsubscribe(subId)
      expect(removed).toBe(true)

      await messageBus.publish('user.login', { userId: '123' })
      await new Promise(resolve => setTimeout(resolve, 10))

      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('RPC with Pattern Subscriptions', () => {
    beforeEach(() => {
      messageBus = new MessageBus({ enablePatternTrie: true })
    })

    afterEach(async () => {
      await messageBus.shutdown()
    })

    it('should handle RPC requests correctly', async () => {
      messageBus.createRpcHandler<{ x: number; y: number }, number>(
        'math.add',
        (payload) => payload.x + payload.y
      )

      const result = await messageBus.request<{ x: number; y: number }, number>(
        'math.add',
        { x: 5, y: 3 },
        1000
      )

      expect(result).toBe(8)
    })
  })

  /**
   * Sprint 6 Day 3: RPC Reliability Tests
   * Tests for memory leak fix - reply subscriptions cleanup on timeout
   */
  describe('RPC Timeout Memory Leak Fix (Sprint 6 Day 3)', () => {
    beforeEach(() => {
      messageBus = new MessageBus({ enablePatternTrie: true })
    })

    afterEach(async () => {
      await messageBus.shutdown()
    })

    it('should clean up reply subscription on RPC rejection (no subscriber)', async () => {
      // Get initial subscription count
      const statsBefore = messageBus.getStats()
      const initialExactSubs = statsBefore.exactSubscriptions

      // Make RPC request that will fail immediately (no handler -> "No subscriber")
      const requestPromise = messageBus.request('nonexistent.topic', { data: 'test' }, 50)

      // Request should fail with "No subscriber for RPC target"
      await expect(requestPromise).rejects.toThrow('No subscriber for RPC target')

      // Give time for cleanup
      await new Promise(resolve => setTimeout(resolve, 10))

      // Verify subscription was cleaned up - no leaked subscriptions
      const statsAfter = messageBus.getStats()
      expect(statsAfter.exactSubscriptions).toBe(initialExactSubs)
      expect(statsAfter.pendingRpcCount).toBe(0)
    })

    it('should clean up reply subscription on actual RPC timeout', async () => {
      const statsBefore = messageBus.getStats()
      const initialExactSubs = statsBefore.exactSubscriptions

      // Create a handler that delays response beyond timeout
      messageBus.createRpcHandler<{ data: string }, string>(
        'slow.handler',
        async () => {
          await new Promise(resolve => setTimeout(resolve, 200)) // Takes 200ms
          return 'too late'
        }
      )

      // After creating handler, we have +1 subscription
      const statsAfterHandler = messageBus.getStats()
      expect(statsAfterHandler.exactSubscriptions).toBe(initialExactSubs + 1)

      // Make RPC request with short timeout
      const requestPromise = messageBus.request('slow.handler', { data: 'test' }, 50)

      // Request should timeout
      await expect(requestPromise).rejects.toThrow('RPC timeout')

      // Give time for cleanup
      await new Promise(resolve => setTimeout(resolve, 10))

      // Verify reply subscription was cleaned up (only the slow.handler subscription remains)
      const statsAfter = messageBus.getStats()
      expect(statsAfter.exactSubscriptions).toBe(initialExactSubs + 1) // +1 for slow.handler only
      expect(statsAfter.pendingRpcCount).toBe(0)
    })

    it('should clean up pending RPC on timeout with slow handler', async () => {
      // Create a handler that delays response beyond timeout
      messageBus.createRpcHandler<{ data: string }, string>(
        'slow.handler',
        async () => {
          await new Promise(resolve => setTimeout(resolve, 200))
          return 'too late'
        }
      )

      // Make RPC request that will timeout
      const requestPromise = messageBus.request('slow.handler', { data: 'test' }, 50)

      // Wait a bit to let the request be processed
      await new Promise(resolve => setTimeout(resolve, 10))

      // During request, there should be 1 pending RPC
      const statsDuring = messageBus.getStats()
      expect(statsDuring.pendingRpcCount).toBe(1)

      // Wait for timeout
      await expect(requestPromise).rejects.toThrow('RPC timeout')

      // After timeout, pending RPC should be cleaned up
      const statsAfter = messageBus.getStats()
      expect(statsAfter.pendingRpcCount).toBe(0)
    })

    it('should handle multiple concurrent RPC timeouts without memory leak', async () => {
      const statsBeforeHandlers = messageBus.getStats()
      const initialExactSubs = statsBeforeHandlers.exactSubscriptions

      // Create slow handlers for each request
      for (let i = 0; i < 5; i++) {
        messageBus.createRpcHandler<{ index: number }, string>(
          `slow.handler.${i}`,
          async () => {
            await new Promise(resolve => setTimeout(resolve, 200))
            return 'too late'
          }
        )
      }

      // After creating 5 handlers, we should have +5 subscriptions
      const statsAfterHandlers = messageBus.getStats()
      expect(statsAfterHandlers.exactSubscriptions).toBe(initialExactSubs + 5)

      // Launch multiple RPC requests that will all timeout
      const requests = Array.from({ length: 5 }, (_, i) =>
        messageBus.request(`slow.handler.${i}`, { index: i }, 50)
      )

      // All should timeout (use Promise.allSettled to wait for all)
      const results = await Promise.allSettled(requests)

      // Verify all rejected with timeout
      results.forEach(result => {
        expect(result.status).toBe('rejected')
        if (result.status === 'rejected') {
          expect(result.reason.message).toBe('RPC timeout')
        }
      })

      // Give time for all cleanups
      await new Promise(resolve => setTimeout(resolve, 50))

      // Verify all reply subscriptions were cleaned up
      // Only the 5 slow handlers remain (no leaked reply subscriptions)
      const statsAfter = messageBus.getStats()
      expect(statsAfter.exactSubscriptions).toBe(initialExactSubs + 5)
      expect(statsAfter.pendingRpcCount).toBe(0)
    })

    it('should clean up subscription on successful RPC completion', async () => {
      const statsBefore = messageBus.getStats()
      const initialExactSubs = statsBefore.exactSubscriptions

      // Create handler for RPC
      messageBus.createRpcHandler<{ x: number }, number>(
        'math.double',
        (payload) => payload.x * 2
      )

      // Make RPC request
      const result = await messageBus.request<{ x: number }, number>(
        'math.double',
        { x: 10 },
        1000
      )

      expect(result).toBe(20)

      // Give time for cleanup
      await new Promise(resolve => setTimeout(resolve, 10))

      // Verify reply subscription was cleaned up
      // Note: exactSubscriptions will be +1 for the RPC handler itself
      const statsAfter = messageBus.getStats()
      expect(statsAfter.exactSubscriptions).toBe(initialExactSubs + 1)
      expect(statsAfter.pendingRpcCount).toBe(0)
    })

    it('should track active RPC correlations metric', async () => {
      const { coreMetrics } = await import('../integration/metrics/metrics')
      const gaugeMock = coreMetrics.gauge as Mock

      // Create slow handler
      messageBus.createRpcHandler<{ data: string }, string>(
        'slow.handler',
        async () => {
          await new Promise(resolve => setTimeout(resolve, 200))
          return 'too late'
        }
      )

      // Clear previous calls
      gaugeMock.mockClear()

      // Make RPC request that will timeout
      const requestPromise = messageBus.request('slow.handler', { data: 'test' }, 50)

      // Should have called gauge for active correlations
      expect(gaugeMock).toHaveBeenCalledWith('rpc_active_correlations', expect.any(Number))

      await expect(requestPromise).rejects.toThrow('RPC timeout')

      // Should have updated gauge after cleanup
      const gaugeCalls = gaugeMock.mock.calls.filter(
        (call: [string, number]) => call[0] === 'rpc_active_correlations'
      )
      expect(gaugeCalls.length).toBeGreaterThanOrEqual(2)

      // Last call should have value 0 (all cleaned up)
      const lastCall = gaugeCalls[gaugeCalls.length - 1] as [string, number]
      expect(lastCall[1]).toBe(0)
    })

    it('should increment rpcTimeouts metric on timeout', async () => {
      const { coreMetrics } = await import('../integration/metrics/metrics')
      const incMock = coreMetrics.inc as Mock

      // Create slow handler
      messageBus.createRpcHandler<{ data: string }, string>(
        'slow.handler',
        async () => {
          await new Promise(resolve => setTimeout(resolve, 200))
          return 'too late'
        }
      )

      // Clear previous calls
      incMock.mockClear()

      // Make RPC request that will timeout
      await expect(
        messageBus.request('slow.handler', { data: 'test' }, 50)
      ).rejects.toThrow('RPC timeout')

      // Should have incremented rpcTimeouts
      expect(incMock).toHaveBeenCalledWith('rpcTimeouts')
    })

    it('should handle RPC error response without memory leak', async () => {
      const statsBefore = messageBus.getStats()
      const initialExactSubs = statsBefore.exactSubscriptions

      // Create handler that throws error
      messageBus.createRpcHandler<{ value: number }, number>(
        'error.handler',
        () => {
          throw new Error('Handler error')
        }
      )

      // Make RPC request - it should receive error response
      const result = await messageBus.request<{ value: number }, { error: string }>(
        'error.handler',
        { value: 42 },
        1000
      )

      // Should receive error message
      expect(result).toEqual({ error: 'Handler error' })

      // Give time for cleanup
      await new Promise(resolve => setTimeout(resolve, 10))

      // Verify no leaked subscriptions (+1 for the error handler)
      const statsAfter = messageBus.getStats()
      expect(statsAfter.exactSubscriptions).toBe(initialExactSubs + 1)
      expect(statsAfter.pendingRpcCount).toBe(0)
    })

    it('should cleanup on "No subscriber for RPC target" rejection', async () => {
      const { coreMetrics } = await import('../integration/metrics/metrics')
      const gaugeMock = coreMetrics.gauge as Mock

      // Clear previous calls
      gaugeMock.mockClear()

      const statsBefore = messageBus.getStats()

      // Make RPC request that will fail immediately (no handler)
      await expect(
        messageBus.request('nonexistent.topic', { data: 'test' }, 50)
      ).rejects.toThrow('No subscriber for RPC target')

      // Verify cleanup happened
      const statsAfter = messageBus.getStats()
      expect(statsAfter.pendingRpcCount).toBe(0)
      expect(statsAfter.exactSubscriptions).toBe(statsBefore.exactSubscriptions)
    })
  })

  describe('Shutdown Behavior', () => {
    it('should gracefully shutdown with PatternTrie mode', async () => {
      const bus = new MessageBus({ enablePatternTrie: true })
      bus.subscribePattern('test.*', vi.fn())

      await expect(bus.shutdown()).resolves.not.toThrow()
    })

    it('should gracefully shutdown with legacy mode', async () => {
      const bus = new MessageBus({ enablePatternTrie: false })
      bus.subscribePattern('test.*', vi.fn())

      await expect(bus.shutdown()).resolves.not.toThrow()
    })
  })
})

describe('PatternManager Plugin Support', () => {
  let messageBus: MessageBus

  beforeEach(() => {
    messageBus = new MessageBus({ enablePatternTrie: true })
  })

  afterEach(async () => {
    await messageBus.shutdown()
  })

  it('should pass plugin to PatternManager subscriptions', async () => {
    const handler = vi.fn()
    messageBus.subscribePattern('plugin.*', handler, 'my-plugin')

    // Verify plugin is tracked
    const removed = messageBus.unsubscribeByPlugin('my-plugin')
    expect(removed).toBe(1)
  })

  it('should handle multiple plugins with pattern subscriptions', async () => {
    messageBus.subscribePattern('alpha.*', vi.fn(), 'plugin-alpha')
    messageBus.subscribePattern('beta.*', vi.fn(), 'plugin-beta')
    messageBus.subscribePattern('gamma.*', vi.fn(), 'plugin-alpha')

    const statsBeforeRemoval = messageBus.getStats()
    expect(statsBeforeRemoval.patternSubscriptions).toBe(3)

    const removedCount = messageBus.unsubscribeByPlugin('plugin-alpha')
    expect(removedCount).toBe(2)

    const statsAfterRemoval = messageBus.getStats()
    expect(statsAfterRemoval.patternSubscriptions).toBe(1)
  })
})
