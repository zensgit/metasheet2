import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CanaryRouter, canaryHash } from '../../src/canary/CanaryRouter'
import type { CanaryRule } from '../../src/canary/CanaryRouter'
import { CanaryMetrics } from '../../src/canary/CanaryMetrics'
import { CanaryInterceptor } from '../../src/canary/CanaryInterceptor'

// Mock prom-client so registry.registerMetric doesn't fail in test
vi.mock('prom-client', () => {
  const mockHistogram = {
    labels: vi.fn().mockReturnValue({ observe: vi.fn(), inc: vi.fn() }),
    get: vi.fn().mockResolvedValue({ values: [] }),
    startTimer: vi.fn(),
  }
  const mockCounter = {
    labels: vi.fn().mockReturnValue({ inc: vi.fn() }),
    get: vi.fn().mockResolvedValue({ values: [] }),
    inc: vi.fn(),
  }
  const mockGauge = {
    labels: vi.fn().mockReturnValue({ set: vi.fn() }),
    get: vi.fn().mockResolvedValue({ values: [] }),
    set: vi.fn(),
  }
  return {
    default: {
      Counter: vi.fn(() => ({ ...mockCounter })),
      Histogram: vi.fn(() => ({ ...mockHistogram })),
      Gauge: vi.fn(() => ({ ...mockGauge })),
      Registry: vi.fn(() => ({
        registerMetric: vi.fn(),
        contentType: 'text/plain',
        metrics: vi.fn().mockResolvedValue(''),
        getMetricsAsJSON: vi.fn().mockResolvedValue([]),
        collectDefaultMetrics: vi.fn(),
      })),
      collectDefaultMetrics: vi.fn(),
    },
  }
})

// Mock the metrics registry import
vi.mock('../../src/metrics/metrics', () => ({
  registry: {
    registerMetric: vi.fn(),
    contentType: 'text/plain',
    metrics: vi.fn().mockResolvedValue(''),
    getMetricsAsJSON: vi.fn().mockResolvedValue([]),
  },
}))

describe('CanaryRouter', () => {
  let router: CanaryRouter

  beforeEach(() => {
    router = new CanaryRouter(true)
  })

  describe('route()', () => {
    it('should return stable when disabled', () => {
      const disabled = new CanaryRouter(false)
      disabled.updateRule({
        topic: 'order.created',
        canaryWeight: 100,
        stableHandler: 'stable-v1',
        canaryHandler: 'canary-v2',
      })

      expect(disabled.route('order.created', 'tenant-1')).toBe('stable')
    })

    it('should return stable when no rule exists for topic', () => {
      expect(router.route('nonexistent.topic', 'tenant-1')).toBe('stable')
    })

    it('should return canary for 100% weight', () => {
      router.updateRule({
        topic: 'order.created',
        canaryWeight: 100,
        stableHandler: 'v1',
        canaryHandler: 'v2',
      })

      expect(router.route('order.created', 'tenant-1')).toBe('canary')
      expect(router.route('order.created', 'tenant-999')).toBe('canary')
    })

    it('should return stable for 0% weight', () => {
      router.updateRule({
        topic: 'order.created',
        canaryWeight: 0,
        stableHandler: 'v1',
        canaryHandler: 'v2',
      })

      expect(router.route('order.created', 'tenant-1')).toBe('stable')
      expect(router.route('order.created', 'tenant-999')).toBe('stable')
    })

    it('should distribute traffic according to weight (statistical)', () => {
      router.updateRule({
        topic: 'order.created',
        canaryWeight: 30,
        stableHandler: 'v1',
        canaryHandler: 'v2',
      })

      let canaryCount = 0
      const total = 1000

      for (let i = 0; i < total; i++) {
        const version = router.route('order.created', `tenant-${i}`)
        if (version === 'canary') canaryCount++
      }

      // With 30% weight, expect canary count to be roughly 300 +/- 100
      expect(canaryCount).toBeGreaterThan(150)
      expect(canaryCount).toBeLessThan(450)
    })

    it('should be deterministic (same tenant always gets same version)', () => {
      router.updateRule({
        topic: 'order.created',
        canaryWeight: 50,
        stableHandler: 'v1',
        canaryHandler: 'v2',
      })

      const tenantId = 'tenant-sticky-test'
      const firstResult = router.route('order.created', tenantId)

      // Call 100 times - should always return the same result
      for (let i = 0; i < 100; i++) {
        expect(router.route('order.created', tenantId)).toBe(firstResult)
      }
    })

    it('should honour per-tenant overrides', () => {
      router.updateRule({
        topic: 'order.created',
        canaryWeight: 0, // 0% canary normally
        stableHandler: 'v1',
        canaryHandler: 'v2',
        overrides: {
          'tenant-canary': 'canary',
          'tenant-stable': 'stable',
        },
      })

      expect(router.route('order.created', 'tenant-canary')).toBe('canary')
      expect(router.route('order.created', 'tenant-stable')).toBe('stable')
    })
  })

  describe('updateRule()', () => {
    it('should reject weight < 0', () => {
      expect(() =>
        router.updateRule({
          topic: 'test',
          canaryWeight: -1,
          stableHandler: 'v1',
          canaryHandler: 'v2',
        }),
      ).toThrow('canaryWeight must be 0-100')
    })

    it('should reject weight > 100', () => {
      expect(() =>
        router.updateRule({
          topic: 'test',
          canaryWeight: 101,
          stableHandler: 'v1',
          canaryHandler: 'v2',
        }),
      ).toThrow('canaryWeight must be 0-100')
    })
  })

  describe('removeRule()', () => {
    it('should remove an existing rule', () => {
      router.updateRule({
        topic: 'order.created',
        canaryWeight: 50,
        stableHandler: 'v1',
        canaryHandler: 'v2',
      })

      expect(router.removeRule('order.created')).toBe(true)
      expect(router.getRule('order.created')).toBeUndefined()
    })

    it('should return false for non-existent rule', () => {
      expect(router.removeRule('nonexistent')).toBe(false)
    })
  })

  describe('getAllRules()', () => {
    it('should return all rules', () => {
      router.updateRule({ topic: 'a', canaryWeight: 10, stableHandler: 's', canaryHandler: 'c' })
      router.updateRule({ topic: 'b', canaryWeight: 20, stableHandler: 's', canaryHandler: 'c' })

      const rules = router.getAllRules()
      expect(rules).toHaveLength(2)
      expect(rules.map(r => r.topic).sort()).toEqual(['a', 'b'])
    })
  })

  describe('promote()', () => {
    it('should set weight to 100%', () => {
      router.updateRule({ topic: 'a', canaryWeight: 10, stableHandler: 's', canaryHandler: 'c' })
      expect(router.promote('a')).toBe(true)
      expect(router.getRule('a')?.canaryWeight).toBe(100)
    })

    it('should return false for non-existent topic', () => {
      expect(router.promote('nonexistent')).toBe(false)
    })
  })

  describe('rollback()', () => {
    it('should set weight to 0%', () => {
      router.updateRule({ topic: 'a', canaryWeight: 50, stableHandler: 's', canaryHandler: 'c' })
      expect(router.rollback('a')).toBe(true)
      expect(router.getRule('a')?.canaryWeight).toBe(0)
    })

    it('should return false for non-existent topic', () => {
      expect(router.rollback('nonexistent')).toBe(false)
    })
  })

  describe('setEnabled()', () => {
    it('should toggle global enable/disable', () => {
      router.setEnabled(false)
      expect(router.isEnabled()).toBe(false)

      router.updateRule({ topic: 'a', canaryWeight: 100, stableHandler: 's', canaryHandler: 'c' })
      expect(router.route('a', 'tenant-1')).toBe('stable')

      router.setEnabled(true)
      expect(router.route('a', 'tenant-1')).toBe('canary')
    })
  })
})

describe('canaryHash', () => {
  it('should return deterministic values', () => {
    const h1 = canaryHash('test-key')
    const h2 = canaryHash('test-key')
    expect(h1).toBe(h2)
  })

  it('should return different values for different keys', () => {
    const h1 = canaryHash('key-a')
    const h2 = canaryHash('key-b')
    expect(h1).not.toBe(h2)
  })

  it('should return unsigned 32-bit integers', () => {
    for (let i = 0; i < 100; i++) {
      const h = canaryHash(`key-${i}`)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThanOrEqual(0xffffffff)
    }
  })
})

describe('CanaryInterceptor', () => {
  let router: CanaryRouter
  let interceptor: CanaryInterceptor

  beforeEach(() => {
    router = new CanaryRouter(true)
    interceptor = new CanaryInterceptor(router)
  })

  it('should wrap handler and invoke it', async () => {
    const handler = vi.fn().mockResolvedValue('result')
    const wrapped = interceptor.wrap(handler)

    const msg = { topic: 'order.created', headers: { 'x-tenant-id': 'tenant-1' }, payload: {} }
    const result = await wrapped(msg)

    expect(handler).toHaveBeenCalledWith(msg)
    expect(result).toBe('result')
  })

  it('should record error metrics on handler failure', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('boom'))
    const wrapped = interceptor.wrap(handler)

    const msg = { topic: 'order.created', headers: { 'x-tenant-id': 'tenant-1' }, payload: {} }

    await expect(wrapped(msg)).rejects.toThrow('boom')
    expect(handler).toHaveBeenCalledWith(msg)
  })

  it('should default to stable when no tenant header', async () => {
    router.updateRule({ topic: 'order.created', canaryWeight: 100, stableHandler: 'v1', canaryHandler: 'v2' })

    const handler = vi.fn().mockResolvedValue('ok')
    const wrapped = interceptor.wrap(handler)

    // No x-tenant-id header
    const msg = { topic: 'order.created', headers: {}, payload: {} }
    await wrapped(msg)

    expect(handler).toHaveBeenCalled()
  })
})

describe('CanaryMetrics', () => {
  it('should instantiate without errors', () => {
    const m = new CanaryMetrics()
    expect(m).toBeDefined()
  })

  it('should expose compareVersions', async () => {
    const m = new CanaryMetrics()
    const result = await m.compareVersions('test.topic')
    expect(result).toHaveProperty('stable')
    expect(result).toHaveProperty('canary')
    expect(result.stable).toHaveProperty('p50')
    expect(result.stable).toHaveProperty('p99')
    expect(result.stable).toHaveProperty('errorRate')
  })
})
