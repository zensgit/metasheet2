import { describe, it, expect } from 'vitest'
import { metrics } from '../metrics/metrics'
import { recordFallback } from '../fallback/fallback-recorder'

describe('Fallback effective exclusion logic', () => {
  it('excludes cache_miss when COUNT_CACHE_MISS_AS_FALLBACK=false', async () => {
    process.env.COUNT_CACHE_MISS_AS_FALLBACK = 'false'
    recordFallback('cache_miss')
    const raw = await metrics.fallbackRawTotal.get()
    const eff = await metrics.fallbackEffectiveTotal.get()
    const rawMiss = raw.values.find(v => v.labels.reason === 'cache_miss')
    const effMiss = eff.values.find(v => v.labels.reason === 'cache_miss')
    expect(rawMiss).toBeDefined()
    expect(effMiss).toBeUndefined()
  })

  it('includes cache_miss when COUNT_CACHE_MISS_AS_FALLBACK=true', async () => {
    process.env.COUNT_CACHE_MISS_AS_FALLBACK = 'true'
    recordFallback('cache_miss')
    const eff = await metrics.fallbackEffectiveTotal.get()
    const effMiss = eff.values.find(v => v.labels.reason === 'cache_miss')
    expect(effMiss).toBeDefined()
  })
})
