import { describe, it, expect } from 'vitest'
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

  it('has recovery attempts metric registered', () => {
    // Verify the counter exists and is properly set up
    expect(metrics.redisRecoveryAttemptsTotal).toBeDefined()
  })

  it('can increment recovery attempts manually', async () => {
    // Manually increment to verify counter works
    metrics.redisRecoveryAttemptsTotal.labels('error').inc()
    const prom = await metrics.redisRecoveryAttemptsTotal.get()
    // Counter values have labels.result field, not metricName
    const errorSamples = prom.values.filter(v => v.labels.result === 'error')
    expect(errorSamples.length).toBeGreaterThan(0)
    expect(errorSamples[0].value).toBeGreaterThan(0)
  })
})
