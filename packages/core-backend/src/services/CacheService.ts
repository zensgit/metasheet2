// @ts-nocheck
/**
 * 缓存服务实现
 * 支持 Redis 和内存缓存，提供完整的缓存操作
 */

import { EventEmitter } from 'eventemitter3'
import type {
  CacheService,
  CacheSetOptions
} from '../types/plugin'
import { Logger } from '../core/logger'

/**
 * 缓存提供者接口
 */
interface CacheProvider {
  get(key: string): Promise<any>
  set(key: string, value: any, options?: CacheSetOptions): Promise<void>
  delete(key: string): Promise<void>
  exists(key: string): Promise<boolean>
  mget(keys: string[]): Promise<(any | null)[]>
  mset(pairs: Array<{key: string, value: any, options?: CacheSetOptions}>): Promise<void>
  mdel(keys: string[]): Promise<void>
  increment(key: string, value?: number): Promise<number>
  expire(key: string, seconds: number): Promise<void>
  ttl(key: string): Promise<number>
  size(): Promise<number>
  clear(): Promise<void>
  invalidateByPattern(pattern: string): Promise<void>
}

/**
 * 内存缓存提供者
 */
class MemoryCacheProvider implements CacheProvider {
  private cache = new Map<string, {
    value: any
    expiresAt?: number
    tags?: string[]
  }>()
  private tagIndex = new Map<string, Set<string>>()
  private logger: Logger

  constructor() {
    this.logger = new Logger('MemoryCacheProvider')

    // 定期清理过期缓存
    setInterval(() => {
      this.cleanExpired()
    }, 60000) // 每分钟清理一次
  }

  async get(key: string): Promise<any> {
    const item = this.cache.get(key)
    if (!item) return null

    if (item.expiresAt && Date.now() > item.expiresAt) {
      await this.delete(key)
      return null
    }

    return item.value
  }

  async set(key: string, value: any, options: CacheSetOptions = {}): Promise<void> {
    const { ttl, tags, nx, xx } = options

    if (nx && this.cache.has(key)) {
      return // 只有不存在时才设置
    }

    if (xx && !this.cache.has(key)) {
      return // 只有存在时才设置
    }

    const item: any = { value }

    if (ttl && ttl > 0) {
      item.expiresAt = Date.now() + (ttl * 1000)
    }

    if (tags && tags.length > 0) {
      item.tags = tags
      // 更新标签索引
      for (const tag of tags) {
        if (!this.tagIndex.has(tag)) {
          this.tagIndex.set(tag, new Set())
        }
        this.tagIndex.get(tag)!.add(key)
      }
    }

    this.cache.set(key, item)
  }

  async delete(key: string): Promise<void> {
    const item = this.cache.get(key)
    if (item && item.tags) {
      // 从标签索引中移除
      for (const tag of item.tags) {
        const keySet = this.tagIndex.get(tag)
        if (keySet) {
          keySet.delete(key)
          if (keySet.size === 0) {
            this.tagIndex.delete(tag)
          }
        }
      }
    }

    this.cache.delete(key)
  }

  async exists(key: string): Promise<boolean> {
    const item = this.cache.get(key)
    if (!item) return false

    if (item.expiresAt && Date.now() > item.expiresAt) {
      await this.delete(key)
      return false
    }

    return true
  }

  async mget(keys: string[]): Promise<(any | null)[]> {
    return Promise.all(keys.map(key => this.get(key)))
  }

  async mset(pairs: Array<{key: string, value: any, options?: CacheSetOptions}>): Promise<void> {
    await Promise.all(pairs.map(({ key, value, options }) =>
      this.set(key, value, options)
    ))
  }

  async mdel(keys: string[]): Promise<void> {
    await Promise.all(keys.map(key => this.delete(key)))
  }

  async increment(key: string, value: number = 1): Promise<number> {
    const current = await this.get(key) || 0
    const newValue = Number(current) + value
    await this.set(key, newValue)
    return newValue
  }

  async expire(key: string, seconds: number): Promise<void> {
    const item = this.cache.get(key)
    if (item) {
      item.expiresAt = Date.now() + (seconds * 1000)
    }
  }

  async ttl(key: string): Promise<number> {
    const item = this.cache.get(key)
    if (!item) return -2
    if (!item.expiresAt) return -1

    const remaining = Math.ceil((item.expiresAt - Date.now()) / 1000)
    return Math.max(remaining, -1)
  }

  async size(): Promise<number> {
    return this.cache.size
  }

  async clear(): Promise<void> {
    this.cache.clear()
    this.tagIndex.clear()
  }

  async invalidateByPattern(pattern: string): Promise<void> {
    const regex = new RegExp(pattern.replace(/\*/g, '.*'))
    const keysToDelete: string[] = []

    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        keysToDelete.push(key)
      }
    }

    await this.mdel(keysToDelete)
  }

  private cleanExpired(): void {
    const now = Date.now()
    const expiredKeys: string[] = []

    for (const [key, item] of this.cache.entries()) {
      if (item.expiresAt && now > item.expiresAt) {
        expiredKeys.push(key)
      }
    }

    for (const key of expiredKeys) {
      this.cache.delete(key)
    }

    if (expiredKeys.length > 0) {
      this.logger.debug(`Cleaned ${expiredKeys.length} expired cache entries`)
    }
  }
}

/**
 * Redis 缓存提供者
 */
class RedisCacheProvider implements CacheProvider {
  private redis: any
  private logger: Logger

  constructor(redisClient: any) {
    this.redis = redisClient
    this.logger = new Logger('RedisCacheProvider')
  }

  async get(key: string): Promise<any> {
    try {
      const value = await this.redis.get(key)
      return value ? JSON.parse(value) : null
    } catch (error) {
      this.logger.error(`Failed to get cache key ${key}`, error as Error)
      return null
    }
  }

  async set(key: string, value: any, options: CacheSetOptions = {}): Promise<void> {
    try {
      const { ttl, nx, xx } = options
      const serialized = JSON.stringify(value)

      const args: any[] = [key, serialized]

      if (ttl && ttl > 0) {
        args.push('EX', ttl)
      }

      if (nx) {
        args.push('NX')
      } else if (xx) {
        args.push('XX')
      }

      await this.redis.set(...args)

      // 处理标签
      if (options.tags && options.tags.length > 0) {
        const tagPromises = options.tags.map(tag =>
          this.redis.sadd(`tag:${tag}`, key)
        )
        await Promise.all(tagPromises)
      }
    } catch (error) {
      this.logger.error(`Failed to set cache key ${key}`, error as Error)
      throw error
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.redis.del(key)
    } catch (error) {
      this.logger.error(`Failed to delete cache key ${key}`, error as Error)
      throw error
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      const result = await this.redis.exists(key)
      return result === 1
    } catch (error) {
      this.logger.error(`Failed to check cache key existence ${key}`, error as Error)
      return false
    }
  }

  async mget(keys: string[]): Promise<(any | null)[]> {
    try {
      if (keys.length === 0) return []

      const values = await this.redis.mget(...keys)
      return values.map((value: string | null) =>
        value ? JSON.parse(value) : null
      )
    } catch (error) {
      this.logger.error(`Failed to mget cache keys`, error as Error)
      return keys.map(() => null)
    }
  }

  async mset(pairs: Array<{key: string, value: any, options?: CacheSetOptions}>): Promise<void> {
    try {
      // 使用管道提升性能
      const pipeline = this.redis.pipeline()

      for (const { key, value, options = {} } of pairs) {
        const serialized = JSON.stringify(value)

        if (options.ttl && options.ttl > 0) {
          pipeline.setex(key, options.ttl, serialized)
        } else {
          pipeline.set(key, serialized)
        }

        // 处理标签
        if (options.tags && options.tags.length > 0) {
          for (const tag of options.tags) {
            pipeline.sadd(`tag:${tag}`, key)
          }
        }
      }

      await pipeline.exec()
    } catch (error) {
      this.logger.error(`Failed to mset cache keys`, error as Error)
      throw error
    }
  }

  async mdel(keys: string[]): Promise<void> {
    try {
      if (keys.length === 0) return
      await this.redis.del(...keys)
    } catch (error) {
      this.logger.error(`Failed to mdel cache keys`, error as Error)
      throw error
    }
  }

  async increment(key: string, value: number = 1): Promise<number> {
    try {
      return await this.redis.incrby(key, value)
    } catch (error) {
      this.logger.error(`Failed to increment cache key ${key}`, error as Error)
      throw error
    }
  }

  async expire(key: string, seconds: number): Promise<void> {
    try {
      await this.redis.expire(key, seconds)
    } catch (error) {
      this.logger.error(`Failed to set expiration for cache key ${key}`, error as Error)
      throw error
    }
  }

  async ttl(key: string): Promise<number> {
    try {
      return await this.redis.ttl(key)
    } catch (error) {
      this.logger.error(`Failed to get TTL for cache key ${key}`, error as Error)
      return -2
    }
  }

  async size(): Promise<number> {
    try {
      return await this.redis.dbsize()
    } catch (error) {
      this.logger.error(`Failed to get cache size`, error as Error)
      return 0
    }
  }

  async clear(): Promise<void> {
    try {
      await this.redis.flushdb()
    } catch (error) {
      this.logger.error(`Failed to clear cache`, error as Error)
      throw error
    }
  }

  async invalidateByPattern(pattern: string): Promise<void> {
    try {
      const keys = await this.redis.keys(pattern)
      if (keys.length > 0) {
        await this.redis.del(...keys)
      }
    } catch (error) {
      this.logger.error(`Failed to invalidate by pattern ${pattern}`, error as Error)
      throw error
    }
  }
}

/**
 * 统一缓存服务实现
 */
export class CacheServiceImpl extends EventEmitter implements CacheService {
  private provider: CacheProvider
  private logger: Logger
  private metrics: {
    hits: number
    misses: number
    operations: number
  } = { hits: 0, misses: 0, operations: 0 }

  constructor(provider?: CacheProvider) {
    super()
    this.provider = provider || new MemoryCacheProvider()
    this.logger = new Logger('CacheService')
  }

  async get<T = any>(key: string): Promise<T | null> {
    try {
      this.metrics.operations++
      const value = await this.provider.get(key)

      if (value !== null) {
        this.metrics.hits++
        this.emit('cache:hit', { key, value })
      } else {
        this.metrics.misses++
        this.emit('cache:miss', { key })
      }

      return value
    } catch (error) {
      this.logger.error(`Cache get failed for key: ${key}`, error as Error)
      this.emit('cache:error', { operation: 'get', key, error })
      return null
    }
  }

  async set<T = any>(key: string, value: T, options?: CacheSetOptions): Promise<void> {
    try {
      this.metrics.operations++
      await this.provider.set(key, value, options)
      this.emit('cache:set', { key, value, options })
    } catch (error) {
      this.logger.error(`Cache set failed for key: ${key}`, error as Error)
      this.emit('cache:error', { operation: 'set', key, error })
      throw error
    }
  }

  async delete(key: string): Promise<void> {
    try {
      this.metrics.operations++
      await this.provider.delete(key)
      this.emit('cache:delete', { key })
    } catch (error) {
      this.logger.error(`Cache delete failed for key: ${key}`, error as Error)
      this.emit('cache:error', { operation: 'delete', key, error })
      throw error
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      return await this.provider.exists(key)
    } catch (error) {
      this.logger.error(`Cache exists check failed for key: ${key}`, error as Error)
      return false
    }
  }

  async mget<T = any>(keys: string[]): Promise<(T | null)[]> {
    try {
      this.metrics.operations++
      const values = await this.provider.mget(keys)

      // 统计命中率
      values.forEach((value, index) => {
        if (value !== null) {
          this.metrics.hits++
          this.emit('cache:hit', { key: keys[index], value })
        } else {
          this.metrics.misses++
          this.emit('cache:miss', { key: keys[index] })
        }
      })

      return values
    } catch (error) {
      this.logger.error(`Cache mget failed`, error as Error)
      this.emit('cache:error', { operation: 'mget', keys, error })
      return keys.map(() => null)
    }
  }

  async mset<T = any>(pairs: Array<{key: string, value: T, options?: CacheSetOptions}>): Promise<void> {
    try {
      this.metrics.operations++
      await this.provider.mset(pairs)
      this.emit('cache:mset', { pairs })
    } catch (error) {
      this.logger.error(`Cache mset failed`, error as Error)
      this.emit('cache:error', { operation: 'mset', pairs, error })
      throw error
    }
  }

  async mdel(keys: string[]): Promise<void> {
    try {
      this.metrics.operations++
      await this.provider.mdel(keys)
      this.emit('cache:mdel', { keys })
    } catch (error) {
      this.logger.error(`Cache mdel failed`, error as Error)
      this.emit('cache:error', { operation: 'mdel', keys, error })
      throw error
    }
  }

  async invalidateByTag(tag: string): Promise<void> {
    try {
      this.emit('cache:invalidate:tag', { tag })

      // 对于内存缓存，通过标签索引查找
      if (this.provider instanceof MemoryCacheProvider) {
        const tagIndex = (this.provider as any).tagIndex as Map<string, Set<string>>
        const keys = tagIndex.get(tag)
        if (keys && keys.size > 0) {
          await this.mdel(Array.from(keys))
        }
      } else {
        // 对于 Redis，通过集合获取标签相关的键
        const redis = (this.provider as any).redis
        if (redis) {
          const keys = await redis.smembers(`tag:${tag}`)
          if (keys.length > 0) {
            await this.mdel(keys)
            await redis.del(`tag:${tag}`)
          }
        }
      }
    } catch (error) {
      this.logger.error(`Cache tag invalidation failed for tag: ${tag}`, error as Error)
      throw error
    }
  }

  async invalidateByPattern(pattern: string): Promise<void> {
    try {
      await this.provider.invalidateByPattern(pattern)
      this.emit('cache:invalidate:pattern', { pattern })
    } catch (error) {
      this.logger.error(`Cache pattern invalidation failed for pattern: ${pattern}`, error as Error)
      throw error
    }
  }

  async increment(key: string, value?: number): Promise<number> {
    try {
      this.metrics.operations++
      const result = await this.provider.increment(key, value)
      this.emit('cache:increment', { key, value, result })
      return result
    } catch (error) {
      this.logger.error(`Cache increment failed for key: ${key}`, error as Error)
      this.emit('cache:error', { operation: 'increment', key, error })
      throw error
    }
  }

  async expire(key: string, seconds: number): Promise<void> {
    try {
      await this.provider.expire(key, seconds)
      this.emit('cache:expire', { key, seconds })
    } catch (error) {
      this.logger.error(`Cache expire failed for key: ${key}`, error as Error)
      throw error
    }
  }

  async ttl(key: string): Promise<number> {
    try {
      return await this.provider.ttl(key)
    } catch (error) {
      this.logger.error(`Cache TTL check failed for key: ${key}`, error as Error)
      return -2
    }
  }

  async size(): Promise<number> {
    try {
      return await this.provider.size()
    } catch (error) {
      this.logger.error(`Cache size check failed`, error as Error)
      return 0
    }
  }

  async clear(): Promise<void> {
    try {
      await this.provider.clear()
      this.metrics = { hits: 0, misses: 0, operations: 0 }
      this.emit('cache:clear')
    } catch (error) {
      this.logger.error(`Cache clear failed`, error as Error)
      this.emit('cache:error', { operation: 'clear', error })
      throw error
    }
  }

  /**
   * 获取缓存统计信息
   */
  getMetrics() {
    const hitRate = this.metrics.operations > 0 ?
      (this.metrics.hits / (this.metrics.hits + this.metrics.misses)) * 100 : 0

    return {
      ...this.metrics,
      hitRate: Number(hitRate.toFixed(2))
    }
  }

  /**
   * 重置统计信息
   */
  resetMetrics() {
    this.metrics = { hits: 0, misses: 0, operations: 0 }
  }

  /**
   * 创建 Redis 缓存服务
   */
  static createRedisService(redisClient: any): CacheServiceImpl {
    return new CacheServiceImpl(new RedisCacheProvider(redisClient))
  }

  /**
   * 创建内存缓存服务
   */
  static createMemoryService(): CacheServiceImpl {
    return new CacheServiceImpl(new MemoryCacheProvider())
  }
}

export { MemoryCacheProvider, RedisCacheProvider }