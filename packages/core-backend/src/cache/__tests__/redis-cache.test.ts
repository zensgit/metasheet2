import { describe, it, expect, beforeEach, vi } from 'vitest'
vi.mock('ioredis', () => {
  class MockRedis {
    private behavior: { mode: 'ok' | 'fail'; get?: any; set?: any; del?: number } = { mode: 'ok' }
    constructor(_url: string, _opts: any) {}
    async connect() { if (this.behavior.mode === 'fail') throw new Error('connect fail') }
    on() {/* no-op */}
    setBehavior(b: Partial<MockRedis['behavior']>) { this.behavior = { ...this.behavior, ...b } }
    async get(_key: string) { if (this.behavior.mode === 'fail') throw new Error('get fail'); return this.behavior.get ?? null }
    async set(_key: string, _val: string) { if (this.behavior.mode === 'fail') throw new Error('set fail'); return this.behavior.set ?? 'OK' }
    async del(_key: string) { if (this.behavior.mode === 'fail') throw new Error('del fail'); return this.behavior.del ?? 1 }
  }
  const inst = new MockRedis('redis://test', {})
  const RedisCtor = vi.fn().mockImplementation((url: string, opts: any) => inst as unknown as any)
  ;(RedisCtor as any).__instance = inst
  return { default: RedisCtor }
})

import { RedisCache } from '../../cache/implementations/redis-cache'
import { registry } from '../../metrics/metrics'

async function metricValue(name: string, matchLabels?: Record<string, string>): Promise<number> {
  const arr = await registry.getMetricsAsJSON()
  const m = arr.find(m => (m as any).name === name) as any
  if (!m) return 0
  if (!matchLabels) {
    // sum all
    return (m.values || []).reduce((acc: number, v: any) => acc + (v.value || 0), 0)
  }
  let sum = 0
  for (const v of m.values || []) {
    const lbls = v.labels || {}
    let ok = true
    for (const [k, val] of Object.entries(matchLabels)) {
      if (lbls[k] !== val) { ok = false; break }
    }
    if (ok) sum += v.value || 0
  }
  return sum
}

describe('RedisCache metrics & behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('records miss on null GET and hit on value', async () => {
    const RedisMod: any = await import('ioredis')
    const inst = (RedisMod.default as any).__instance
    inst.setBehavior({ mode: 'ok', get: null })
    const cache = new RedisCache('redis://test')

    const beforeMiss = await metricValue('cache_miss_total', { impl: 'redis', key_pattern: 'foo' })
    const r1 = await cache.get('foo:bar')
    expect(r1.ok).toBe(true)
    expect(r1.value).toBeNull()
    const afterMiss = await metricValue('cache_miss_total', { impl: 'redis', key_pattern: 'foo' })
    expect(afterMiss).toBe(beforeMiss + 1)

    inst.setBehavior({ get: JSON.stringify('hello') })
    const beforeHit = await metricValue('cache_hits_total', { impl: 'redis', key_pattern: 'foo' })
    const r2 = await cache.get('foo:bar')
    expect(r2.ok).toBe(true)
    expect(r2.value).toBe('hello')
    const afterHit = await metricValue('cache_hits_total', { impl: 'redis', key_pattern: 'foo' })
    expect(afterHit).toBe(beforeHit + 1)
  })

  it('updates last failure timestamp on errors', async () => {
    const RedisMod: any = await import('ioredis')
    const inst = (RedisMod.default as any).__instance
    inst.setBehavior({ mode: 'fail' })
    const cache = new RedisCache('redis://test')
    const r = await cache.get('foo:bar')
    expect(r.ok).toBe(false)

    const ts = await metricValue('redis_last_failure_timestamp')
    expect(ts).toBeGreaterThan(0)
  })

  it('observes operation duration for set and del', async () => {
    const RedisMod: any = await import('ioredis')
    const inst = (RedisMod.default as any).__instance
    inst.setBehavior({ mode: 'ok' })
    const cache = new RedisCache('redis://test')

    const before = await metricValue('redis_operation_duration_seconds_count')
    await cache.set('foo:bar', { a: 1 }, 5)
    await cache.del('foo:bar')
    const after = await metricValue('redis_operation_duration_seconds_count')
    expect(after).toBeGreaterThan(before)
  })
})
