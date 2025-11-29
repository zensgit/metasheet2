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
      // Redis缓存需要额外配置
      try {
        // 动态导入Redis缓存
        const { RedisCache } = require('./cache/implementations/redis-cache')
        const redisCache = new RedisCache({
          host: process.env.REDIS_HOST || 'localhost',
          port: parseInt(process.env.REDIS_PORT || '6379'),
          password: process.env.REDIS_PASSWORD,
        })
        globalCache = new CacheRegistry(redisCache)
        globalCache.register('redis', redisCache)
        globalCache.register('memory', new MemoryCache())
        globalCache.register('null', new NullCache())
        logger.info('Redis cache initialized')
      } catch (error) {
        logger.warn(`Failed to initialize Redis cache, falling back to memory cache: ${error instanceof Error ? error.message : String(error)}`)
        globalCache = new CacheRegistry(new MemoryCache())
        globalCache.register('memory', new MemoryCache())
        globalCache.register('null', new NullCache())
      }
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

// 初始化缓存并导出
export const cache = initializeCache()