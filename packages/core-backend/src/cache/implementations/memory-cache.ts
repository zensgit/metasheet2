import { metrics } from '../../metrics/metrics'
import type { Cache, Result } from '../../types/cache'

type Entry = { value: unknown; expiresAt?: number }

export class MemoryCache implements Cache {
  private store = new Map<string, Entry>()
  readonly impl = 'memory'

  constructor() {
    try { metrics.cache_enabled.set({ impl: this.impl }, 1) } catch { /* metrics unavailable */ }
  }

  private pattern(key: string): string {
    const idx = key.indexOf(':')
    return idx === -1 ? key : key.slice(0, idx)
  }

  async get<T = unknown>(key: string): Promise<Result<T | null>> {
    const now = Date.now()
    const e = this.store.get(key)
    const kp = this.pattern(key)
    try {
      if (!e) {
        metrics.cache_miss_total.inc({ impl: this.impl, key_pattern: kp })
        return { ok: true, value: null }
      }
      if (e.expiresAt && e.expiresAt <= now) {
        this.store.delete(key)
        metrics.cache_miss_total.inc({ impl: this.impl, key_pattern: kp })
        return { ok: true, value: null }
      }
      metrics.cache_hits_total.inc({ impl: this.impl, key_pattern: kp })
      return { ok: true, value: e.value as T }
    } catch (error) {
      try { metrics.cache_errors_total.inc({ impl: this.impl, error_type: 'runtime' }) } catch { /* metrics unavailable */ }
      return { ok: false, error: error as Error }
    }
  }

  async set(key: string, value: unknown, ttlSec?: number): Promise<Result<void>> {
    const kp = this.pattern(key)
    try {
      const expiresAt = ttlSec ? Date.now() + ttlSec * 1000 : undefined
      this.store.set(key, { value, expiresAt })
      metrics.cache_set_total.inc({ impl: this.impl, key_pattern: kp })
      return { ok: true, value: undefined }
    } catch (error) {
      try { metrics.cache_errors_total.inc({ impl: this.impl, error_type: 'runtime' }) } catch { /* metrics unavailable */ }
      return { ok: false, error: error as Error }
    }
  }

  async del(key: string): Promise<Result<void>> {
    const kp = this.pattern(key)
    try {
      this.store.delete(key)
      metrics.cache_del_total.inc({ impl: this.impl, key_pattern: kp })
      return { ok: true, value: undefined }
    } catch (error) {
      try { metrics.cache_errors_total.inc({ impl: this.impl, error_type: 'runtime' }) } catch { /* metrics unavailable */ }
      return { ok: false, error: error as Error }
    }
  }
}
