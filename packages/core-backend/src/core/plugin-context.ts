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

/**
 * 审计API调用
 */
function auditAPICall(plugin: string, api: string, args: any[]): void {
  // TODO: 实现审计日志
  if (process.env.AUDIT_LOG === 'true') {
    console.log(`[AUDIT] Plugin ${plugin} called ${api}`, args)
  }
}

/**
 * 创建插件存储
 */
function createPluginStorage(pluginName: string): PluginStorage {
  // TODO: 实现持久化存储
  const storage = new Map<string, any>()

  return {
    async get(key: string): Promise<any> {
      return storage.get(`${pluginName}:${key}`)
    },

    async set(key: string, value: any): Promise<void> {
      storage.set(`${pluginName}:${key}`, value)
    },

    async delete(key: string): Promise<void> {
      storage.delete(`${pluginName}:${key}`)
    },

    async list(): Promise<string[]> {
      const prefix = `${pluginName}:`
      return Array.from(storage.keys())
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
 */
function loadPluginConfig(pluginName: string): any {
  // TODO: 从配置文件或数据库加载配置
  return {
    // 默认配置
  }
}
