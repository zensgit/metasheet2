import type { Cache } from '../../types/cache'
import { metrics } from '../../metrics/metrics'

function keyPrefix(key: string): string {
  const idx = key.indexOf(':')
  return idx > 0 ? key.slice(0, idx) : 'generic'
}

export class RedisCache implements Cache {
  public readonly implName = 'RedisCache'
  private readonly url?: string

  constructor(url?: string) {
    this.url = url
  }

  async get<T>(key: string): Promise<T | undefined> {
    const labels = { impl: 'redis', key_pattern: keyPrefix(key) }
    try {
      // Placeholder: no real Redis ops yet; behaves like miss
      metrics.cache_miss_total.inc(labels)
      return undefined
    } catch {
      metrics.cache_errors_total.inc(labels)
      return undefined
    }
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const labels = { impl: 'redis', key_pattern: keyPrefix(key) }
    try {
      metrics.cache_set_total.inc(labels)
    } catch {
      metrics.cache_errors_total.inc(labels)
    }
  }

  async del(key: string): Promise<void> {
    const labels = { impl: 'redis', key_pattern: keyPrefix(key) }
    try {
      metrics.cache_del_total.inc(labels)
    } catch {
      metrics.cache_errors_total.inc(labels)
    }
  }
}

