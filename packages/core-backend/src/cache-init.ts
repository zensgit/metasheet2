/**
 * 缓存系统初始化
 * 配置真实的缓存实现，替换NullCache
 */

import { CacheRegistry } from './cache/registry'
import { MemoryCache } from './cache/implementations/memory-cache'
import { NullCache } from './cache/implementations/null-cache'
import { Logger } from './core/logger'

const logger = new Logger('CacheInit')

let globalCache: CacheRegistry | null = null

export function initializeCache(): CacheRegistry {
  if (globalCache) {
    return globalCache
  }

  // 根据环境变量选择缓存实现
  const cacheType = process.env.CACHE_TYPE || 'memory'

  logger.info(`Initializing ${cacheType} cache`)

  switch (cacheType) {
    case 'memory':
      globalCache = new CacheRegistry(new MemoryCache())
      globalCache.register('memory', new MemoryCache())
      globalCache.register('null', new NullCache())
      break

    case 'redis':
      // Redis缓存需要额外配置 - 使用同步初始化回退到memory
      // 注意: Redis初始化需要使用 initializeCacheAsync() 以支持异步加载
      logger.warn('Redis cache requires async initialization. Use initializeCacheAsync() or falling back to memory cache.')
      globalCache = new CacheRegistry(new MemoryCache())
      globalCache.register('memory', new MemoryCache())
      globalCache.register('null', new NullCache())
      break

    case 'null':
    default:
      globalCache = new CacheRegistry(new NullCache())
      globalCache.register('null', new NullCache())
      globalCache.register('memory', new MemoryCache())
      break
  }

  return globalCache
}

/**
 * 异步初始化缓存 - 支持Redis等需要动态加载的实现
 */
export async function initializeCacheAsync(): Promise<CacheRegistry> {
  if (globalCache) {
    return globalCache
  }

  const cacheType = process.env.CACHE_TYPE || 'memory'
  logger.info(`Async initializing ${cacheType} cache`)

  if (cacheType === 'redis') {
    try {
      const { RedisCache } = await import('./cache/implementations/redis-cache')
      const host = process.env.REDIS_HOST || 'localhost'
      const port = process.env.REDIS_PORT || '6379'
      const password = process.env.REDIS_PASSWORD
      const redisUrl = password
        ? `redis://:${password}@${host}:${port}`
        : `redis://${host}:${port}`
      const redisCache = new RedisCache(redisUrl)
      globalCache = new CacheRegistry(redisCache)
      globalCache.register('redis', redisCache)
      globalCache.register('memory', new MemoryCache())
      globalCache.register('null', new NullCache())
      logger.info('Redis cache initialized')
      return globalCache
    } catch (error) {
      logger.warn(`Failed to initialize Redis cache, falling back to memory cache: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 回退到同步初始化
  return initializeCache()
}

// 初始化缓存并导出
export const cache = initializeCache()