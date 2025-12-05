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
import { WebSocketServiceImpl } from '../services/WebSocketService'
import { SecurityServiceImpl } from '../services/SecurityService'
import { ValidationServiceImpl } from '../services/ValidationService'

/**
 * Email configuration for notification service
 */
export interface EmailConfig {
  provider?: 'smtp' | 'sendgrid' | 'ses'
  host?: string
  port?: number
  auth?: {
    user?: string
    pass?: string
  }
  apiKey?: string
  [key: string]: unknown
}

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
      config?: EmailConfig
    }
    webhook?: {
      timeout?: number
    }
  }

  // WebSocket配置
  websocket?: {
    io?: unknown // Socket.IO实例
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
 * 带有事件能力的服务接口
 */
interface ServiceWithEvents {
  on?: (event: string, handler: (...args: unknown[]) => void | Promise<void>) => void
}

/**
 * 调度服务任务接口
 */
interface SchedulerJob {
  name: string
  data: unknown
}

/**
 * 通知批处理接口
 */
interface NotificationBatch {
  type?: string
  recipients?: unknown[]
  content?: unknown
  [key: string]: unknown
}

/**
 * 存储服务文件上传事件
 */
interface FileUploadEvent {
  fileId: string
  metadata: Record<string, unknown>
}

/**
 * 带有配置提供者能力的服务
 */
interface StorageServiceWithProvider {
  configureProvider?: (provider: string, config: unknown) => void
}

/**
 * 带有清理能力的服务
 */
interface ServiceWithCleanup {
  cleanup?: () => void
}

/**
 * 带有统计能力的服务
 */
interface ServiceWithStats {
  getStats?: () => Record<string, unknown>
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
      this.logger.error('Failed to create plugin services', error instanceof Error ? error : undefined)
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
          this.logger.warn('Redis not available, falling back to memory cache', { error })
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
          this.logger.warn('Bull not available, falling back to memory queue', { error })
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

    // Type assertion for service with provider configuration
    const service = new (StorageServiceImpl as unknown as new () => PluginServices['storage'] & StorageServiceWithProvider)()

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
          this.logger.warn('AWS SDK not available, using local storage', { error })
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
          this.logger.warn(`Failed to register notification channel: ${channel}`, { error })
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
    // Type assertion for WebSocket service constructor
    const service = new (WebSocketServiceImpl as unknown as new (io: unknown) => PluginServices['websocket'])(config.io)
    return service
  }

  /**
   * 创建安全服务
   */
  private async createSecurityService() {
    const config = this.options.security || {}
    // Type assertion for Security service constructor
    const service = new (SecurityServiceImpl as unknown as new (encryptionKey?: string) => PluginServices['security'])(config.encryptionKey)
    return service
  }

  /**
   * 创建验证服务
   */
  private async createValidationService() {
    // Type assertion for Validation service constructor
    const service = new (ValidationServiceImpl as unknown as new () => PluginServices['validation'])()
    return service
  }

  /**
   * 设置服务间的相互连接
   */
  private setupServiceInterconnections(services: PluginServices): void {
    // 调度服务使用队列服务执行任务
    const schedulerWithEvents = services.scheduler as PluginServices['scheduler'] & ServiceWithEvents
    schedulerWithEvents.on?.('job:execute', async (job: unknown) => {
      const schedulerJob = job as SchedulerJob
      await services.queue.add('scheduled', schedulerJob.name, schedulerJob.data, {
        delay: 0,
        attempts: 1
      })
    })

    // 通知服务使用队列服务处理大量通知
    const notificationWithEvents = services.notification as PluginServices['notification'] & ServiceWithEvents
    notificationWithEvents.on?.('notification:batch', async (notifications: unknown) => {
      const notificationArray = notifications as NotificationBatch[]
      for (const notification of notificationArray) {
        await services.queue.add('notifications', 'send', notification, {
          attempts: 3,
          backoff: 'exponential'
        })
      }
    })

    // 安全服务使用缓存服务缓存权限检查结果
    const originalCheckPermission = services.security.checkPermission?.bind(services.security)
    if (originalCheckPermission) {
      services.security.checkPermission = async (pluginName: string, permission: string): Promise<boolean> => {
        const cacheKey = `perm:${pluginName}:${permission}`

        const cached = await services.cache.get<boolean>(cacheKey)
        if (cached !== null) {
          return cached
        }

        const result = await originalCheckPermission(pluginName, permission)
        await services.cache.set(cacheKey, result, { ttl: 300 }) // 5分钟缓存

        return result
      }
    }

    // 存储服务使用缓存服务缓存文件元数据
    const storageWithEvents = services.storage as PluginServices['storage'] & ServiceWithEvents
    storageWithEvents.on?.('file:uploaded', async (event: unknown) => {
      const fileEvent = event as FileUploadEvent
      const cacheKey = `file:${fileEvent.fileId}`
      await services.cache.set(cacheKey, fileEvent.metadata, { ttl: 3600 }) // 1小时缓存
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
      if (this.services.scheduler.listJobs) {
        const scheduledJobs = await this.services.scheduler.listJobs()
        for (const job of scheduledJobs) {
          if (this.services.scheduler.unschedule && job.name) {
            await this.services.scheduler.unschedule(job.name)
          }
        }
      }

      // 清理WebSocket连接
      const websocketWithCleanup = this.services.websocket as PluginServices['websocket'] & ServiceWithCleanup
      websocketWithCleanup.cleanup?.()

      // 清理队列
      // 注意: 这里可能需要等待正在运行的任务完成

      this.services = null
      this.logger.info('All plugin services destroyed')
    } catch (error) {
      this.logger.error('Error during service destruction', error instanceof Error ? error : undefined)
      throw error
    }
  }

  /**
   * 获取服务健康状态
   */
  async getHealth(): Promise<Record<string, unknown>> {
    if (!this.services) {
      return { status: 'not_initialized' }
    }

    const health: Record<string, unknown> = {}

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
      const websocketWithStats = this.services.websocket as PluginServices['websocket'] & ServiceWithStats
      health.websocket = {
        status: 'healthy',
        stats: websocketWithStats.getStats?.()
      }
    } catch (error) {
      health.websocket = { status: 'unhealthy', error: (error as Error).message }
    }

    try {
      // 调度器健康检查
      if (this.services.scheduler.listJobs) {
        const jobs = await this.services.scheduler.listJobs()
        health.scheduler = {
          status: 'healthy',
          jobCount: jobs.length,
          activeJobs: jobs.filter((j: { isPaused?: boolean }) => !j.isPaused).length
        }
      } else {
        health.scheduler = { status: 'healthy', jobCount: 0, activeJobs: 0 }
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
