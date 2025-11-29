// @ts-nocheck
/**
 * 插件服务工厂
 * 负责创建和管理所有插件相关服务的实例
 */

import type { PluginServices } from '../types/plugin'
import { Logger } from './logger'

// 导入服务实现
import { CacheServiceImpl } from '../services/CacheService'
import { QueueServiceImpl } from '../services/QueueService'
import { StorageServiceImpl } from '../services/StorageService'
import { SchedulerServiceImpl } from '../services/SchedulerService'
import { NotificationServiceImpl } from '../services/NotificationService'
// 类型宽容：某些实现可能缺少类型声明，使用 any 断言避免编译阻塞
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { WebSocketServiceImpl } from '../services/WebSocketService'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { SecurityServiceImpl } from '../services/SecurityService'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { ValidationServiceImpl } from '../services/ValidationService'

/**
 * 服务配置选项
 */
export interface ServiceFactoryOptions {
  // 缓存配置
  cache?: {
    provider?: 'memory' | 'redis'
    redis?: {
      host?: string
      port?: number
      password?: string
      db?: number
    }
  }

  // 队列配置
  queue?: {
    provider?: 'memory' | 'bull' | 'bullmq'
    redis?: {
      host?: string
      port?: number
      password?: string
      db?: number
    }
  }

  // 存储配置
  storage?: {
    provider?: 'local' | 's3'
    local?: {
      basePath?: string
    }
    s3?: {
      region?: string
      bucket?: string
      accessKeyId?: string
      secretAccessKey?: string
    }
  }

  // 调度器配置
  scheduler?: {
    provider?: 'memory' | 'database'
  }

  // 通知配置
  notification?: {
    channels?: string[]
    email?: {
      provider?: 'smtp' | 'sendgrid' | 'ses'
      config?: any
    }
    webhook?: {
      timeout?: number
    }
  }

  // WebSocket配置
  websocket?: {
    io?: any // Socket.IO实例
  }

  // 安全配置
  security?: {
    encryptionKey?: string
    sandbox?: {
      memoryLimit?: number
      timeoutLimit?: number
    }
  }

  // 验证配置
  validation?: {
    strict?: boolean
  }
}

/**
 * 插件服务工厂
 */
export class PluginServiceFactory {
  private services: PluginServices | null = null
  private options: ServiceFactoryOptions
  private logger: Logger

  constructor(options: ServiceFactoryOptions = {}) {
    this.options = options
    this.logger = new Logger('PluginServiceFactory')
  }

  /**
   * 创建所有服务实例
   */
  async createServices(): Promise<PluginServices> {
    if (this.services) {
      return this.services
    }

    this.logger.info('Creating plugin services...')

    try {
      const services: PluginServices = {
        cache: await this.createCacheService(),
        queue: await this.createQueueService(),
        storage: await this.createStorageService(),
        scheduler: await this.createSchedulerService(),
        notification: await this.createNotificationService(),
        websocket: await this.createWebSocketService(),
        security: await this.createSecurityService(),
        validation: await this.createValidationService()
      }

      // 设置服务间的相互引用
      this.setupServiceInterconnections(services)

      this.services = services
      this.logger.info('All plugin services created successfully')

      return services
    } catch (error) {
      this.logger.error('Failed to create plugin services', error as Error)
      throw error
    }
  }

  /**
   * 创建缓存服务
   */
  private async createCacheService() {
    const config = this.options.cache || {}

    switch (config.provider) {
      case 'redis':
        try {
          // 动态导入Redis客户端（软依赖）
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const Redis = require('ioredis')
          const redis = new Redis(config.redis || {})
          return CacheServiceImpl.createRedisService(redis)
        } catch (error) {
          this.logger.warn('Redis not available, falling back to memory cache', error as Error)
          return CacheServiceImpl.createMemoryService()
        }

      case 'memory':
      default:
        return CacheServiceImpl.createMemoryService()
    }
  }

  /**
   * 创建队列服务
   */
  private async createQueueService() {
    const config = this.options.queue || {}

    switch (config.provider) {
      case 'bull':
      case 'bullmq':
        try {
          // 动态导入Bull队列（软依赖）
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          require('bull')
          const queueService = new QueueServiceImpl()
          return queueService
        } catch (error) {
          this.logger.warn('Bull not available, falling back to memory queue', error as Error)
          return new QueueServiceImpl()
        }

      case 'memory':
      default:
        return new QueueServiceImpl()
    }
  }

  /**
   * 创建存储服务
   */
  private async createStorageService() {
    const config = this.options.storage || {}

    const service: any = new (StorageServiceImpl as any)()

    switch (config.provider) {
      case 's3':
        try {
          // 动态导入AWS SDK（软依赖）
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const AWS = require('aws-sdk')
          const s3 = new AWS.S3(config.s3 || {})
          // 配置S3存储（存在性检查）
          if (typeof service.configureProvider === 'function') {
            service.configureProvider('s3', s3)
          }
        } catch (error) {
          this.logger.warn('AWS SDK not available, using local storage', error as Error)
        }
        break

      case 'local':
      default:
        // 使用本地文件存储
        if (typeof service.configureProvider === 'function') {
          service.configureProvider('local', config.local || {})
        }
        break
    }

    return service
  }

  /**
   * 创建调度服务
   */
  private async createSchedulerService() {
    const config = this.options.scheduler || {}

    const service = new SchedulerServiceImpl()

    // 可以在这里配置调度器的存储后端
    if (config.provider === 'database') {
      // 配置数据库存储
    }

    return service
  }

  /**
   * 创建通知服务
   */
  private async createNotificationService() {
    const config = this.options.notification || {}
    const service = new NotificationServiceImpl()

    // 注册额外的通知渠道
    if (config.channels) {
      for (const channel of config.channels) {
        try {
          switch (channel) {
            case 'dingtalk':
              // 注册钉钉渠道
              break
            case 'teams':
              // 注册Teams渠道
              break
            case 'slack':
              // 注册Slack渠道
              break
          }
        } catch (error) {
          this.logger.warn(`Failed to register notification channel: ${channel}`, error as Error)
        }
      }
    }

    return service
  }

  /**
   * 创建WebSocket服务
   */
  private async createWebSocketService() {
    const config = this.options.websocket || {}
    const service: any = new (WebSocketServiceImpl as any)(config.io)
    return service
  }

  /**
   * 创建安全服务
   */
  private async createSecurityService() {
    const config = this.options.security || {}
    const service: any = new (SecurityServiceImpl as any)(config.encryptionKey)
    return service
  }

  /**
   * 创建验证服务
   */
  private async createValidationService() {
    const config = this.options.validation || {}
    const service: any = new (ValidationServiceImpl as any)()
    return service
  }

  /**
   * 设置服务间的相互连接
   */
  private setupServiceInterconnections(services: PluginServices): void {
    // 调度服务使用队列服务执行任务
    ;(services.scheduler as any).on?.('job:execute', async (job: any) => {
      await services.queue.add('scheduled', job.name, job.data, {
        delay: 0,
        attempts: 1
      })
    })

    // 通知服务使用队列服务处理大量通知
    ;(services.notification as any).on?.('notification:batch', async (notifications: any[]) => {
      for (const notification of notifications) {
        await services.queue.add('notifications', 'send', notification, {
          attempts: 3,
          backoff: 'exponential'
        })
      }
    })

    // 安全服务使用缓存服务缓存权限检查结果
    const originalCheckPermission = services.security.checkPermission
    services.security.checkPermission = async (pluginName: string, permission: string) => {
      const cacheKey = `perm:${pluginName}:${permission}`

      let cached = await services.cache.get(cacheKey)
      if (cached !== null) {
        return cached
      }

      const result = await originalCheckPermission.call(services.security, pluginName, permission)
      await services.cache.set(cacheKey, result, { ttl: 300 }) // 5分钟缓存

      return result
    }

    // 存储服务使用缓存服务缓存文件元数据
    ;(services.storage as any).on?.('file:uploaded', async (event: any) => {
      const cacheKey = `file:${event.fileId}`
      await services.cache.set(cacheKey, event.metadata, { ttl: 3600 }) // 1小时缓存
    })

    this.logger.debug('Service interconnections established')
  }

  /**
   * 获取服务实例（单例模式）
   */
  async getServices(): Promise<PluginServices> {
    if (!this.services) {
      return await this.createServices()
    }
    return this.services
  }

  /**
   * 销毁所有服务
   */
  async destroy(): Promise<void> {
    if (!this.services) return

    this.logger.info('Destroying plugin services...')

    try {
      // 清理缓存
      await this.services.cache.clear()

      // 停止调度器
      const scheduledJobs = await this.services.scheduler.listJobs()
      for (const job of scheduledJobs) {
        await this.services.scheduler.unschedule(job.name)
      }

      // 清理WebSocket连接
      (this.services.websocket as any).cleanup?.()

      // 清理队列
      // 注意: 这里可能需要等待正在运行的任务完成

      this.services = null
      this.logger.info('All plugin services destroyed')
    } catch (error) {
      this.logger.error('Error during service destruction', error as Error)
      throw error
    }
  }

  /**
   * 获取服务健康状态
   */
  async getHealth(): Promise<Record<string, any>> {
    if (!this.services) {
      return { status: 'not_initialized' }
    }

    const health: Record<string, any> = {}

    try {
      // 缓存健康检查
      health.cache = {
        status: 'healthy',
        size: await this.services.cache.size()
      }
    } catch (error) {
      health.cache = { status: 'unhealthy', error: (error as Error).message }
    }

    try {
      // 队列健康检查
      health.queue = {
        status: 'healthy',
        stats: await this.services.queue.getQueueStatus('default')
      }
    } catch (error) {
      health.queue = { status: 'unhealthy', error: (error as Error).message }
    }

    try {
      // WebSocket健康检查
      health.websocket = {
        status: 'healthy',
        stats: (this.services.websocket as any).getStats?.()
      }
    } catch (error) {
      health.websocket = { status: 'unhealthy', error: (error as Error).message }
    }

    try {
      // 调度器健康检查
      const jobs = await this.services.scheduler.listJobs()
      health.scheduler = {
        status: 'healthy',
        jobCount: jobs.length,
        activeJobs: jobs.filter(j => !j.isPaused).length
      }
    } catch (error) {
      health.scheduler = { status: 'unhealthy', error: (error as Error).message }
    }

    return health
  }
}

// 导出单例工厂实例
export const pluginServiceFactory = new PluginServiceFactory()

// 导出便捷方法
export async function getPluginServices(): Promise<PluginServices> {
  return pluginServiceFactory.getServices()
}

export async function configurePluginServices(options: ServiceFactoryOptions): Promise<PluginServices> {
  const factory = new PluginServiceFactory(options)
  return factory.createServices()
}
