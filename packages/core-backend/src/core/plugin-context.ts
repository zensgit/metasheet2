/**
 * 插件上下文工厂
 */

import { EventEmitter } from 'eventemitter3'
import type {
  PluginContext,
  PluginManifest,
  PluginMetadata,
  CoreAPI,
  PluginStorage,
  PluginCommunication,
  Logger
} from '../types/plugin'
import { Logger as LoggerImpl } from './logger'
import { eventBus } from '../integration/events/event-bus'
import { messageBus } from '../integration/messaging/message-bus'

/**
 * 创建插件上下文
 */
export function createPluginContext(
  manifest: PluginManifest,
  coreAPI: CoreAPI
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

  // 创建沙箱化的API
  const sandboxedAPI = createSandboxedAPI(coreAPI, manifest)

  // 创建插件存储
  const storage = createPluginStorage(manifest.name)

  // 创建插件通信
  const communication = createPluginCommunication(manifest.name)

  // 创建日志器
  const logger = new LoggerImpl(`Plugin:${manifest.name}`)

  // 创建插件配置
  const config = loadPluginConfig(manifest.name)

  return {
    metadata,
    api: sandboxedAPI,
    core: sandboxedAPI,  // Provide expected core API structure for backward compatibility
    storage,
    config,
    communication,
    logger
  }
}

/**
 * 创建沙箱化的API
 */
const PERMISSION_MAP: Record<string, string[]> = {
  // High-level group -> underlying allowed roots (simple expansion)
  'database.read': ['database.query'],
  'database.write': ['database.query', 'database.transaction'],
  'events.basic': ['events.on', 'events.emit', 'events.off'],
  'messaging.basic': ['messaging.publish', 'messaging.subscribe', 'messaging.request', 'messaging.rpcHandler'],
  'messaging.pattern': ['messaging.subscribePattern'],
  'messaging.expiry': ['messaging.publish'],
  'http.register': ['http.addRoute'],
}

function expandPermissions(raw: string[]): Set<string> {
  const out = new Set<string>()
  for (const p of raw) {
    out.add(p)
    if (PERMISSION_MAP[p]) {
      for (const t of PERMISSION_MAP[p]) {
        out.add(t)
        // Also add the namespace root for permissions like 'events.emit' -> 'events'
        const [namespace] = t.split('.')
        if (namespace) {
          out.add(namespace)
        }
      }
    }
  }
  return out
}

/**
 * Normalize permissions from V2 object format to array format
 * Supports both old string[] format and new object format
 */
function normalizePermissions(perms: PluginManifest['permissions']): string[] {
  if (!perms) {
    return []
  }

  // Already in array format
  if (Array.isArray(perms)) {
    return perms
  }

  // Convert object format to array format
  const result: string[] = []

  if (perms.database) {
    if (perms.database.read && perms.database.read.length > 0) {
      result.push('database.read')
    }
    if (perms.database.write && perms.database.write.length > 0) {
      result.push('database.write')
    }
  }

  if (perms.http) {
    if (perms.http.internal || (perms.http.external && perms.http.external.length > 0)) {
      result.push('http.register')
    }
  }

  if (perms.filesystem) {
    if (perms.filesystem.read && perms.filesystem.read.length > 0) {
      result.push('filesystem.read')
    }
    if (perms.filesystem.write && perms.filesystem.write.length > 0) {
      result.push('filesystem.write')
    }
  }

  if (perms.events) {
    if ((perms.events.subscribe && perms.events.subscribe.length > 0) ||
        (perms.events.emit && perms.events.emit.length > 0)) {
      result.push('events.basic')
    }
  }

  if (perms.messaging) {
    if ((perms.messaging.subscribe && perms.messaging.subscribe.length > 0) ||
        (perms.messaging.publish && perms.messaging.publish.length > 0) ||
        (perms.messaging.rpc && perms.messaging.rpc.length > 0)) {
      result.push('messaging.basic')
      // Add pattern support if needed
      if (perms.messaging.pattern) {
        result.push('messaging.pattern')
      }
    }
  }

  return result
}

function createSandboxedAPI(api: CoreAPI, manifest: PluginManifest): CoreAPI {
  const rawPerms = normalizePermissions(manifest.permissions)
  // '*' means full access
  const full = rawPerms.includes('*')
  const expanded = expandPermissions(rawPerms)

  return new Proxy(api, {
    get(target, prop: string) {
      // 粗粒度命名空间检查（http/database/events/messaging...）
      if (!full) {
        const root = prop
        // allow basic namespace introspection of auth/storage/cache/queue/websocket for now
        const passiveNamespaces = new Set(['auth', 'storage', 'cache', 'queue', 'websocket'])
        if (!passiveNamespaces.has(root)) {
          const allowed = Array.from(expanded).some(p => p === root || p.startsWith(root + '.'))
          if (!allowed) {
            try {
              const { coreMetrics } = require('../integration/metrics/metrics')
              coreMetrics.inc('permissionDenied')
            } catch {}
            throw new Error(`Permission denied: ${manifest.name} → ${root}`)
          }
        }
      }

      const value = target[prop as keyof CoreAPI]

      // 如果是对象，递归创建代理
      if (typeof value === 'object' && value !== null) {
        return new Proxy(value, {
          get(subTarget, subProp) {
            const subValue = subTarget[subProp as keyof typeof subTarget]

            // 包装函数调用以添加审计
            if (typeof subValue === 'function') {
              return (...args: any[]) => {
                auditAPICall(manifest.name, `${prop}.${String(subProp)}`, args)
                if (!full) {
                  const op = `${prop}.${String(subProp)}`
                  if (!expanded.has(op) && !expanded.has(prop)) {
                    try {
                      const { coreMetrics } = require('../integration/metrics/metrics')
                      coreMetrics.inc('permissionDenied')
                    } catch {}
                    throw new Error(`Permission denied: ${manifest.name} → ${op}`)
                  }
                }
                return (subValue as Function).apply(subTarget, args)
              }
            }

            return subValue
          }
        })
      }

      return value
    }
  })
}

/**
 * 检查权限
 */
function checkPermission(api: string, permissions: string[]): boolean {
  // 实现权限检查逻辑
  // 例如: database.read, database.write, http.*, etc.
  return permissions.some(p => {
    if (p === '*') return true
    if (p === api) return true
    if (p.endsWith('.*') && api.startsWith(p.slice(0, -2))) return true
    return false
  })
}

// Audit log buffer for batching writes
const auditBuffer: Array<{
  timestamp: Date
  plugin: string
  api: string
  argsHash: string
  success: boolean
}> = []
const AUDIT_BUFFER_SIZE = 100
const AUDIT_FLUSH_INTERVAL = 5000 // 5 seconds

// Flush audit buffer periodically
let auditFlushTimer: NodeJS.Timeout | null = null

function startAuditFlushTimer() {
  if (!auditFlushTimer && process.env.AUDIT_LOG === 'true') {
    auditFlushTimer = setInterval(flushAuditBuffer, AUDIT_FLUSH_INTERVAL)
    if (auditFlushTimer.unref) {
      auditFlushTimer.unref()
    }
  }
}

async function flushAuditBuffer() {
  if (auditBuffer.length === 0) return

  const logs = auditBuffer.splice(0, auditBuffer.length)

  // Write to file or send to audit service
  try {
    const fs = require('fs')
    const path = require('path')
    const auditDir = process.env.AUDIT_LOG_DIR || path.join(process.cwd(), 'logs', 'audit')

    // Ensure directory exists
    if (!fs.existsSync(auditDir)) {
      fs.mkdirSync(auditDir, { recursive: true })
    }

    const date = new Date().toISOString().split('T')[0]
    const auditFile = path.join(auditDir, `plugin-audit-${date}.jsonl`)

    // Append logs as JSON lines
    const lines = logs.map(log => JSON.stringify(log)).join('\n') + '\n'
    fs.appendFileSync(auditFile, lines)
  } catch (err) {
    console.error('[Audit] Failed to write audit logs:', err instanceof Error ? err.message : String(err))
  }
}

/**
 * 审计API调用
 * Records plugin API calls for security auditing and debugging
 */
function auditAPICall(plugin: string, api: string, args: any[]): void {
  if (process.env.AUDIT_LOG !== 'true') return

  startAuditFlushTimer()

  // Hash arguments to avoid storing sensitive data
  const crypto = require('crypto')
  const argsHash = crypto.createHash('sha256').update(JSON.stringify(args)).digest('hex').substring(0, 16)

  auditBuffer.push({
    timestamp: new Date(),
    plugin,
    api,
    argsHash,
    success: true
  })

  // Flush if buffer is full
  if (auditBuffer.length >= AUDIT_BUFFER_SIZE) {
    flushAuditBuffer()
  }

  // Also log to console in debug mode
  if (process.env.AUDIT_LOG_VERBOSE === 'true') {
    console.log(`[AUDIT] Plugin ${plugin} called ${api}`, { argsHash })
  }
}

/**
 * 创建插件存储
 * Implements persistent storage using plugin_kv database table
 * Falls back to in-memory storage if database is unavailable
 */
function createPluginStorage(pluginName: string): PluginStorage {
  // In-memory cache for performance
  const memoryCache = new Map<string, any>()

  // Helper to get database connection
  const getDb = async () => {
    try {
      const { db } = await import('../db/db')
      return db
    } catch {
      return null
    }
  }

  return {
    async get(key: string): Promise<any> {
      // Check memory cache first
      const cacheKey = `${pluginName}:${key}`
      if (memoryCache.has(cacheKey)) {
        return memoryCache.get(cacheKey)
      }

      // Try database
      const db = await getDb()
      if (db) {
        try {
          const result = await db.selectFrom('plugin_kv' as any)
            .select(['value'])
            .where('plugin', '=', pluginName)
            .where('key', '=', key)
            .executeTakeFirst()

          if (result?.value !== undefined) {
            const value = result.value
            memoryCache.set(cacheKey, value)
            return value
          }
        } catch (err) {
          // Database error, fall through to return undefined
          const { Logger } = require('./logger')
          const logger = new Logger('PluginStorage')
          logger.debug(`Storage get error for ${pluginName}:${key}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      return undefined
    },

    async set(key: string, value: any): Promise<void> {
      const cacheKey = `${pluginName}:${key}`
      memoryCache.set(cacheKey, value)

      // Persist to database
      const db = await getDb()
      if (db) {
        try {
          // Use upsert pattern
          await db.insertInto('plugin_kv' as any)
            .values({
              plugin: pluginName,
              key,
              value: JSON.stringify(value),
              created_at: new Date(),
              updated_at: new Date()
            })
            .onConflict((oc: any) => oc
              .columns(['plugin', 'key'])
              .doUpdateSet({
                value: JSON.stringify(value),
                updated_at: new Date()
              })
            )
            .execute()
        } catch (err) {
          const { Logger } = require('./logger')
          const logger = new Logger('PluginStorage')
          logger.warn(`Storage set error for ${pluginName}:${key}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    },

    async delete(key: string): Promise<void> {
      const cacheKey = `${pluginName}:${key}`
      memoryCache.delete(cacheKey)

      // Delete from database
      const db = await getDb()
      if (db) {
        try {
          await db.deleteFrom('plugin_kv' as any)
            .where('plugin', '=', pluginName)
            .where('key', '=', key)
            .execute()
        } catch (err) {
          const { Logger } = require('./logger')
          const logger = new Logger('PluginStorage')
          logger.warn(`Storage delete error for ${pluginName}:${key}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    },

    async list(): Promise<string[]> {
      // Try database first for complete list
      const db = await getDb()
      if (db) {
        try {
          const results = await db.selectFrom('plugin_kv' as any)
            .select(['key'])
            .where('plugin', '=', pluginName)
            .execute()

          return results.map((r: any) => r.key)
        } catch (err) {
          const { Logger } = require('./logger')
          const logger = new Logger('PluginStorage')
          logger.debug(`Storage list error for ${pluginName}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      // Fallback to memory cache
      const prefix = `${pluginName}:`
      return Array.from(memoryCache.keys())
        .filter(k => k.startsWith(prefix))
        .map(k => k.slice(prefix.length))
    }
  }
}

/**
 * 创建插件通信
 */
function createPluginCommunication(pluginName: string): PluginCommunication {
  const eventBus = new EventEmitter()
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
      eventBus.on(event, handler as any)
    },

    emit(event: string, data?: any): void {
      eventBus.emit(event, data)
    }
  }
}

/**
 * 加载插件配置
 * Loads configuration from multiple sources with priority:
 * 1. Environment variables (PLUGIN_{NAME}_{KEY})
 * 2. Config file (plugins/{name}/config.json)
 * 3. Database (if available)
 * 4. Default values from manifest
 */
function loadPluginConfig(pluginName: string): any {
  const config: Record<string, any> = {}

  // 1. Load from environment variables
  const envPrefix = `PLUGIN_${pluginName.toUpperCase().replace(/-/g, '_')}_`
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith(envPrefix)) {
      const configKey = key.slice(envPrefix.length).toLowerCase()
      // Try to parse as JSON, otherwise use as string
      try {
        config[configKey] = JSON.parse(value!)
      } catch {
        config[configKey] = value
      }
    }
  }

  // 2. Try to load from config file
  try {
    const fs = require('fs')
    const path = require('path')
    const configPath = path.join(process.cwd(), 'plugins', pluginName, 'config.json')
    if (fs.existsSync(configPath)) {
      const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      // File config has lower priority than env vars
      Object.assign(config, fileConfig, config)
    }
  } catch (err) {
    // Config file loading failed, continue with other sources
    // This is expected for plugins without config files, only log in debug mode
    if (process.env.LOG_LEVEL === 'debug') {
      const { Logger } = require('./logger')
      const logger = new Logger('PluginConfig')
      logger.debug(`No config file for ${pluginName}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return config
}
