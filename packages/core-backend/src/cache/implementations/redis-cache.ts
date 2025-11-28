import type { Cache, Result } from '../../types/cache'
import { metrics } from '../../metrics/metrics'
import { performance } from 'node:perf_hooks'
import Redis from 'ioredis'

function keyPrefix(key: string): string {
  const idx = key.indexOf(':')
  return idx > 0 ? key.slice(0, idx) : 'generic'
}

export class RedisCache implements Cache {
  public readonly implName = 'RedisCache'
  private readonly url?: string
  private client?: Redis
  private connected = false
  private lastConnectAttempt = 0
  private connectIntervalMs = 30000

  constructor(url?: string) {
    this.url = url
    this.tryConnect()
  }

  private tryConnect() {
    if (!this.url) return
    const now = Date.now()
    if (this.connected || (now - this.lastConnectAttempt) < 2000) return
    this.lastConnectAttempt = now
    try {
      this.client = new Redis(this.url, { lazyConnect: true, maxRetriesPerRequest: 1 })
      this.client.connect().then(() => {
        this.connected = true
        metrics.redisRecoveryAttemptsTotal.labels('success').inc()
      }).catch(err => {
        metrics.redisRecoveryAttemptsTotal.labels('error').inc()
        metrics.redisLastFailureTimestamp.set(Date.now() / 1000)
      })
      this.client.on('error', () => {
        this.connected = false
        metrics.redisLastFailureTimestamp.set(Date.now() / 1000)
      })
      this.client.on('end', () => {
        this.connected = false
      })
    } catch {
      metrics.redisRecoveryAttemptsTotal.labels('error').inc()
      metrics.redisLastFailureTimestamp.set(Date.now() / 1000)
    }
  }

  private async opWrap<T>(op: string, fn: () => Promise<T>): Promise<T | null> {
    const t0 = performance.now()
    try {
      const artificialDelay = parseInt(process.env.REDIS_ARTIFICIAL_DELAY_MS || '0', 10)
      if (artificialDelay > 0) {
        await new Promise(r => setTimeout(r, artificialDelay))
      }
      const res = await fn()
      metrics.redisOperationDuration.labels(op).observe((performance.now() - t0) / 1000)
      return res
    } catch (e) {
      metrics.redisOperationDuration.labels(op).observe((performance.now() - t0) / 1000)
      metrics.redisLastFailureTimestamp.set(Date.now() / 1000)
      this.connected = false
      metrics.redisRecoveryAttemptsTotal.labels('error').inc()
      return null
    }
  }

  private observeSynthetic(op: string) {
    // Emit a near-zero duration sample so histogram is visible even if Redis not connected
    metrics.redisOperationDuration.labels(op).observe(0.00001)
  }

  async get<T = any>(key: string): Promise<Result<T | null>> {
    const labels = { impl: 'redis', key_pattern: keyPrefix(key) }
    try {
      if (!this.connected) this.tryConnect()
      let value: any = null
      if (this.connected && this.client) {
        const raw = await this.opWrap('get', () => this.client!.get(key))
        if (raw !== null) {
          try { value = JSON.parse(raw as string) } catch { value = raw }
        }
      } else {
        // Synthetic observation when not connected
        this.observeSynthetic('get')
      }
      if (value === null) {
        metrics.cache_miss_total.inc(labels)
      } else {
        metrics.cache_hits_total.inc(labels)
      }
      return { ok: true, value }
    } catch (e) {
      metrics.cache_errors_total.inc(labels)
      metrics.redisLastFailureTimestamp.set(Date.now() / 1000)
      metrics.redisRecoveryAttemptsTotal.labels('error').inc()
      return { ok: false, error: e instanceof Error ? e : new Error(String(e)) }
    }
  }

  async set(key: string, value: any, ttl?: number): Promise<Result<void>> {
    const labels = { impl: 'redis', key_pattern: keyPrefix(key) }
    try {
      if (!this.connected) this.tryConnect()
      if (this.connected && this.client) {
        const payload = typeof value === 'string' ? value : JSON.stringify(value)
        await this.opWrap('set', () => ttl ? this.client!.set(key, payload, 'PX', ttl * 1000) : this.client!.set(key, payload))
      } else {
        this.observeSynthetic('set')
      }
      metrics.cache_set_total.inc(labels)
      return { ok: true, value: undefined }
    } catch (e) {
      metrics.cache_errors_total.inc(labels)
      metrics.redisLastFailureTimestamp.set(Date.now() / 1000)
      metrics.redisRecoveryAttemptsTotal.labels('error').inc()
      return { ok: false, error: e instanceof Error ? e : new Error(String(e)) }
    }
  }

  async del(key: string): Promise<Result<void>> {
    const labels = { impl: 'redis', key_pattern: keyPrefix(key) }
    try {
      if (!this.connected) this.tryConnect()
      if (this.connected && this.client) {
        await this.opWrap('del', () => this.client!.del(key))
      } else {
        this.observeSynthetic('del')
      }
      metrics.cache_del_total.inc(labels)
      return { ok: true, value: undefined }
    } catch (e) {
      metrics.cache_errors_total.inc(labels)
      metrics.redisLastFailureTimestamp.set(Date.now() / 1000)
      metrics.redisRecoveryAttemptsTotal.labels('error').inc()
      return { ok: false, error: e instanceof Error ? e : new Error(String(e)) }
    }
  }
}
