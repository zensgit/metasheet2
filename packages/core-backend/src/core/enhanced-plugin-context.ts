/**
 * 增强版插件上下文
 * 集成所有新的服务和功能
 */

import { EventEmitter } from 'eventemitter3'
import type {
  PluginContext,
  PluginManifest,
  PluginMetadata,
  CoreAPI,
  PluginStorage,
  PluginCommunication,
  PluginServices,
  Logger
} from '../types/plugin'
import { Logger as LoggerImpl } from './logger'
import { auditLog } from '../audit/audit'
import { metrics } from '../metrics/metrics'
import { db } from '../db/db'

// Import service implementations
import { CacheServiceImpl } from '../services/CacheService'
import { QueueServiceImpl } from '../services/QueueService'
import { StorageServiceImpl } from '../services/StorageService'
import { SchedulerServiceImpl } from '../services/SchedulerService'
import { NotificationServiceImpl } from '../services/NotificationService'
import { WebSocketServiceImpl } from '../services/WebSocketService'
import { SecurityServiceImpl } from '../services/SecurityService'
import { ValidationServiceImpl } from '../services/ValidationService'

/**
 * 增强版插件上下文创建器
 */
export function createEnhancedPluginContext(
  manifest: PluginManifest,
  coreAPI: CoreAPI,
  serviceInstances?: Partial<PluginServices>
): PluginContext {
  // 创建插件元信息
  const metadata: PluginMetadata = {
    name: manifest.name,
    version: manifest.version,
    displayName: manifest.displayName,
    description: manifest.description,
    author: manifest.author,
    path: manifest.path || ''
  }

  // 创建或使用现有服务实例
  const services: PluginServices = {
    cache: (serviceInstances?.cache as any) || CacheServiceImpl.createMemoryService(),
    queue: (serviceInstances?.queue as any) || new (QueueServiceImpl as any)(),
    storage: (serviceInstances?.storage as any) || new (StorageServiceImpl as any)(),
    scheduler: (serviceInstances?.scheduler as any) || new (SchedulerServiceImpl as any)(),
    notification: (serviceInstances?.notification as any) || new (NotificationServiceImpl as any)(),
    websocket: (serviceInstances?.websocket as any) || new (WebSocketServiceImpl as any)(),
    security: (serviceInstances?.security as any) || new (SecurityServiceImpl as any)(),
    validation: (serviceInstances?.validation as any) || new (ValidationServiceImpl as any)()
  }

  // 创建沙箱化的API
  const sandboxedAPI = createEnhancedSandboxedAPI(coreAPI, manifest, services)

  // 创建增强的插件存储
  const storage = createEnhancedPluginStorage(manifest.name)

  // 创建插件通信
  const communication = createPluginCommunication(manifest.name)

  // 创建日志器
  const logger = new LoggerImpl(`Plugin:${manifest.name}`)

  // 创建插件配置（从配置管理器加载）
  const config = loadPluginConfig(manifest.name)

  // 设置插件安全沙箱
  const sandbox = services.security.createSandbox(manifest.name)

  // 监听服务事件并转发到插件
  setupServiceEventForwarding(services, manifest.name, logger)

  return {
    metadata,
    api: sandboxedAPI,
    storage,
    config,
    communication,
    logger,
    services
  }
}

/**
 * 创建增强的沙箱化API
 */
function createEnhancedSandboxedAPI(
  api: CoreAPI,
  manifest: PluginManifest,
  services: PluginServices
): CoreAPI {
  const permissions = new Set(manifest.permissions || [])

  // 权限检查辅助函数
  const hasPermission = (perm: string) =>
    permissions.has('*') || permissions.has(perm) ||
    (perm.includes('.') && permissions.has(perm.split('.')[0] + '.*'))

  const wrapAsyncCall = async (cap: string, fn: (...a: any[]) => Promise<any> | any, args: any[]) => {
    // 检查权限
    if (!hasPermission(cap)) {
      try {
        ;(metrics as any).pluginPermissionDenied?.labels?.(manifest.name, cap)?.inc?.()
      } catch {}
      await auditAPICall(manifest.name, cap, args, 'denied')
      throw new Error(`Plugin ${manifest.name} lacks permission: ${cap}`)
    }

    // 检查速率限制
    const rateLimitResult = await services.security.checkRateLimit(manifest.name, cap)
    if (!rateLimitResult.allowed) {
      throw new Error(`Rate limit exceeded for ${cap}. Retry after ${rateLimitResult.retryAfter} seconds.`)
    }

    // 审计日志
    await auditAPICall(manifest.name, cap, args, 'allowed')

    // 资源监控
    const startTime = Date.now()
    const startMemory = process.memoryUsage().heapUsed

    try {
      const result = await fn(...args)

      // 记录资源使用
      const endTime = Date.now()
      const endMemory = process.memoryUsage().heapUsed

      await services.security.monitorResource(manifest.name, cap, {
        resource: `${cap}_execution_time`,
        current: endTime - startTime,
        limit: 30000, // 30 seconds default limit
        unit: 'ms',
        timestamp: new Date()
      })

      await services.security.monitorResource(manifest.name, cap, {
        resource: `${cap}_memory_usage`,
        current: Math.max(0, endMemory - startMemory),
        limit: 50 * 1024 * 1024, // 50MB default limit
        unit: 'bytes',
        timestamp: new Date()
      })

      return result
    } catch (error) {
      // 记录错误
      await services.security.audit({
        id: `error_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        pluginName: manifest.name,
        event: 'api_error',
        resource: cap,
        action: 'call',
        timestamp: new Date(),
        metadata: { error: (error as Error).message },
        severity: 'error'
      })
      throw error
    }
  }

  // HTTP API增强
  const http = api.http && {
    addRoute: (...args: any[]) => wrapAsyncCall('http.addRoute', (api.http as any).addRoute, args as any),
    removeRoute: (...args: any[]) => wrapAsyncCall('http.addRoute', (api.http as any).removeRoute, args as any),
    middleware: (...args: any[]) => (api.http as any).middleware?.(...(args as any)),
    request: (...args: any[]) => wrapAsyncCall('http.request', (api.http as any).request, args as any)
  }

  // 数据库API增强
  const database = api.database && {
    query: async (sql: string, params?: any[]) => {
      const intent = classifySqlIntent(sql)
      const cap = intent === 'read' ? 'database.read' : 'database.write'

      // SQL威胁扫描
      const threatScan = await services.security.scanForThreats(manifest.name, sql)
      if (!threatScan.safe) {
        const criticalThreats = threatScan.threats.filter(t => t.severity === 'critical')
        if (criticalThreats.length > 0) {
          throw new Error(`SQL security threats detected: ${criticalThreats.map(t => t.description).join(', ')}`)
        }
      }

      return wrapAsyncCall(cap, (api.database as any).query, [sql, params])
    },
    transaction: async (callback: (trx: any) => Promise<any>) => {
      return wrapAsyncCall('database.write', (api.database as any).transaction, [callback])
    },
    model: (...args: any[]) => wrapAsyncCall('database.read', (api.database as any).model, args as any)
  }

  // 存储API增强（使用服务）
  const storage = {
    upload: async (...args: any[]) => {
      await hasPermission('file.write')
      return (services.storage as any).upload(...(args as any))
    },
    download: async (...args: any[]) => {
      await hasPermission('file.read')
      return (services.storage as any).download(...(args as any))
    },
    delete: async (...args: any[]) => {
      await hasPermission('file.write')
      return (services.storage as any).delete(...(args as any))
    },
    getUrl: async (...args: any[]) => {
      await hasPermission('file.read')
      return (services.storage as any).getFileUrl(...(args as any))
    }
  }

  // WebSocket API增强（使用服务）
  const websocket = {
    broadcast: (...args: any[]) => {
      if (!hasPermission('websocket.broadcast')) {
        throw new Error(`Permission denied: websocket.broadcast`)
      }
      return (services.websocket as any).broadcast(...(args as any))
    },
    broadcastTo: (...args: any[]) => {
      if (!hasPermission('websocket.broadcastTo')) {
        throw new Error(`Permission denied: websocket.broadcastTo`)
      }
      return (services.websocket as any).broadcastToRoom(...(args as any))
    },
    join: (...args: any[]) => wrapAsyncCall('websocket.join', (services.websocket as any).join.bind(services.websocket), args as any),
    leave: (...args: any[]) => wrapAsyncCall('websocket.leave', (services.websocket as any).leave.bind(services.websocket), args as any),
    sendTo: (...args: any[]) => {
      if (!hasPermission('websocket.broadcast')) {
        throw new Error(`Permission denied: websocket.broadcast`)
      }
      return (services.websocket as any).sendTo(...(args as any))
    },
    onConnection: (...args: any[]) => (services.websocket as any).onConnection(...(args as any))
  }

  // 通知API（使用服务）
  const notification = {
    send: async (...args: any[]) => {
      if (!hasPermission('notification.send')) {
        throw new Error(`Permission denied: notification.send`)
      }
      return (services.notification as any).send?.(...(args as any))
    }
  }

  // 事件API
  const events = api.events && {
    emit: (...args: any[]) => wrapAsyncCall('events.emit', (...inner: any[]) => (api.events as any).emit?.(...inner), args as any),
    on: (...args: any[]) => (api.events as any).on?.(...(args as any)),
    once: (...args: any[]) => (api.events as any).once?.(...(args as any)),
    off: (...args: any[]) => (api.events as any).off?.(...(args as any))
  }

  // 缓存API（使用服务）
  const cache = {
    get: (...args: any[]) => (services.cache as any).get?.apply(services.cache as any, args as any),
    set: (...args: any[]) => (services.cache as any).set?.apply(services.cache as any, args as any),
    delete: (...args: any[]) => (services.cache as any).delete?.apply(services.cache as any, args as any),
    clear: (...args: any[]) => (services.cache as any).clear?.apply(services.cache as any, args as any)
  }

  // 队列API（使用服务）
  const queue = {
    push: (...args: any[]) => {
      if (!hasPermission('queue.push')) {
        throw new Error(`Permission denied: queue.push`)
      }
      return (services.queue as any).add?.('default', 'task', ...(args as any))
    },
    process: (...args: any[]) => (services.queue as any).process?.(...(args as any)),
    cancel: (...args: any[]) => (services.queue as any).removeJob?.(...(args as any))
  }

  return {
    http: http as any,
    database: database as any,
    auth: api.auth,
    events: events as any,
    storage: storage as any,
    cache: cache as any,
    queue: queue as any,
    websocket: websocket as any,
    notification: notification as any,
    // pass-through view service API from core API
    views: (api as any).views
  }
}

/**
 * 创建增强的插件存储
 */
function createEnhancedPluginStorage(pluginName: string): PluginStorage {
  // 支持数据库和内存存储
  const memory = new Map<string, any>()

  return {
    async get(key: string): Promise<any> {
      if (!db) return memory.get(key)

      try {
        const row = await db.selectFrom('plugin_kv')
          .selectAll()
          .where('plugin_id', '=', pluginName)
          .where('key', '=', key)
          .executeTakeFirst()
        return row ? row.value : undefined
      } catch (error) {
        // 回退到内存存储
        return memory.get(key)
      }
    },

    async set(key: string, value: any): Promise<void> {
      if (!db) {
        memory.set(key, value)
        return
      }

      try {
        await db
          .insertInto('plugin_kv')
          .values({
            plugin_id: pluginName,
            key,
            value
          })
          .onConflict(oc => oc.columns(['plugin_id','key']).doUpdateSet({
            value
          }))
          .execute()
      } catch (error) {
        // 回退到内存存储
        memory.set(key, value)
      }
    },

    async delete(key: string): Promise<void> {
      if (!db) {
        memory.delete(key)
        return
      }

      try {
        await db.deleteFrom('plugin_kv')
          .where('plugin_id', '=', pluginName)
          .where('key', '=', key)
          .execute()
      } catch (error) {
        // 回退到内存存储
        memory.delete(key)
      }
    },

    async list(): Promise<string[]> {
      if (!db) return Array.from(memory.keys())

      try {
        const rows = await db.selectFrom('plugin_kv')
          .select(['key'])
          .where('plugin_id', '=', pluginName)
          .orderBy('key asc')
          .execute()
        return rows.map(r => r.key as string)
      } catch (error) {
        // 回退到内存存储
        return Array.from(memory.keys())
      }
    }
  }
}

/**
 * 创建插件通信
 */
function createPluginCommunication(pluginName: string): PluginCommunication {
  const eventBus: EventEmitter = new EventEmitter()
  const apis = new Map<string, Record<string, Function>>()

  return {
    async call(plugin: string, method: string, ...args: any[]): Promise<any> {
      const api = apis.get(plugin)
      if (!api) {
        throw new Error(`Plugin ${plugin} not found`)
      }

      const fn = api[method]
      if (!fn) {
        throw new Error(`Method ${method} not found in plugin ${plugin}`)
      }

      return fn(...args)
    },

    register(name: string, api: Record<string, Function>): void {
      apis.set(name || pluginName, api)
    },

    on(event: string, handler: Function): void {
      ;(eventBus as any).on(event, handler as any)
    },

    emit(event: string, data?: any): void {
      ;(eventBus as any).emit(event, data)
    }
  }
}

/**
 * 设置服务事件转发
 */
function setupServiceEventForwarding(
  services: PluginServices,
  pluginName: string,
  logger: Logger
): void {
  // 缓存事件
  ;(services.cache as any).on?.('cache:error', (event: any) => {
    logger.error(`Cache error: ${event.error?.message}`)
  })

  // 队列事件
  ;(services.queue as any).on?.('default', 'failed', (job: any, error: any) => {
    logger.error(`Job failed: ${job.name} - ${error.message}`)
  })

  // 通知事件
  ;(services.notification as any).on?.('notification:error', (event: any) => {
    logger.error(`Notification error: ${event.error?.message}`)
  })

  // WebSocket事件
  ;(services.websocket as any).on?.('error', (event: any) => {
    logger.error(`WebSocket error: ${event.error?.message}`)
  })

  // 安全事件
  ;(services.security as any).on?.('audit', (event: any) => {
    if (event.severity === 'error' || event.severity === 'critical') {
      logger.warn(`Security audit [${event.severity}]: ${event.event}`)
    }
  })
}

/**
 * 审计API调用
 */
async function auditAPICall(plugin: string, cap: string, args: any[], result: 'allowed' | 'denied') {
  try {
    await auditLog({
      actorType: 'system',
      action: 'plugin.api',
      resourceType: 'plugin',
      resourceId: plugin,
      meta: { capability: cap, result }
    })
  } catch {}
}

/**
 * 分类SQL意图
 */
function classifySqlIntent(sql: string): 'read' | 'write' {
  const s = (sql || '').trim().toUpperCase()
  if (!s) return 'read'
  if (s.startsWith('SELECT') || s.startsWith('WITH')) return 'read'
  return 'write'
}

/**
 * 加载插件配置
 */
function loadPluginConfig(pluginName: string): any {
  // TODO: 集成PluginConfigManager
  return {
    // 默认配置
  }
}
