import { describe, it, expect } from '@jest/globals'
import { RedisCache } from '../cache/implementations/redis-cache'
import { metrics } from '../metrics/metrics'

// These tests exercise synthetic metric emission and recovery attempt counters
describe('RedisCache metrics', () => {
  it('emits synthetic samples when not connected', async () => {
    const cache = new RedisCache(undefined)
    await cache.get('phase5:test:1')
    await cache.set('phase5:test:1', 'v')
    // Histogram should have bucket counts >0 for get/set synthetic observations
    const prom = await metrics.redisOperationDuration.get()
    const buckets = prom.values.filter(v => v.metricName === 'redis_operation_duration_seconds_bucket')
    const hasGet = buckets.some(b => b.labels.op === 'get' && Number(b.value) > 0)
    const hasSet = buckets.some(b => b.labels.op === 'set' && Number(b.value) > 0)
    expect(hasGet).toBe(true)
    expect(hasSet).toBe(true)
  })

  it('increments recovery attempts on errors', async () => {
    const cache = new RedisCache('redis://invalid-host:6379')
    await cache.get('phase5:test:2')
    const prom = await metrics.redisRecoveryAttemptsTotal.get()
    const errorSamples = prom.values.filter(v => v.metricName === 'redis_recovery_attempts_total' && v.labels.result === 'error')
    expect(errorSamples.length).toBeGreaterThan(0)
  })
})
