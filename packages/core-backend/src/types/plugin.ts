// @ts-nocheck
/**
 * 插件系统核心类型定义
 * Last updated: 2025-11-03 (Batch 1 完成)
 */

import { EventEmitter } from 'eventemitter3'
import { Express, RequestHandler } from 'express'
import { Server as SocketServer } from 'socket.io'

/**
 * 插件生命周期接口
 */
export interface PluginLifecycle {
  // 安装时调用（只执行一次）
  install?(context: PluginContext): Promise<void>

  // 激活时调用（每次加载）
  activate(context: PluginContext): Promise<void>

  // 停用时调用
  deactivate?(): Promise<void>

  // 卸载时调用
  uninstall?(): Promise<void>

  // 配置变更时调用
  onConfigChange?(config: any): void
}

/**
 * 插件上下文
 */
export interface PluginContext {
  // 插件元信息
  metadata: PluginMetadata

  // 核心API
  api: CoreAPI

  // 向后兼容的核心API别名（许多插件期望使用这个名称）
  core: CoreAPI

  // 插件服务（增强功能）
  services?: PluginServices

  // 插件存储
  storage: PluginStorage

  // 插件配置
  config: any

  // 插件通信
  communication: PluginCommunication

  // 日志
  logger: Logger
}

/**
 * 插件元信息
 */
export interface PluginMetadata {
  name: string
  version: string
  displayName?: string
  description?: string
  author?: string
  path: string
}

/**
 * 插件配置清单
 */
export interface PluginManifest {
  name: string
  version: string
  displayName?: string
  description?: string
  author?: string
  license?: string
  path?: string // Plugin file path (added during loading)

  engines?: {
    metasheet: string
    node?: string
  }

  main?: {
    backend?: string
    frontend?: string
  }

  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>

  contributes?: {
    views?: any[]
    commands?: any[]
    menus?: any
    configuration?: any
    fieldTypes?: any[]
    formulas?: any[]
    triggers?: any[]
    actions?: any[]
  }

  // Support both old array format and new V2 object format
  permissions?: string[] | {
    database?: {
      read?: string[]
      write?: string[]
    }
    http?: {
      internal?: boolean
      external?: string[]
    }
    filesystem?: {
      read?: string[]
      write?: string[]
    }
    events?: {
      subscribe?: string[]
      emit?: string[]
    }
    messaging?: {
      subscribe?: string[]
      publish?: string[]
      rpc?: string[]
      pattern?: boolean
    }
  }

  lifecycle?: {
    install?: string
    activate?: string
    deactivate?: string
    uninstall?: string
  }

  activationEvents?: string[]
}

/**
 * 核心API接口
 */
export interface CoreAPI {
  http: HttpAPI
  database: DatabaseAPI
  auth: AuthAPI
  events: EventAPI
  storage: StorageAPI
  cache: CacheAPI
  queue: QueueAPI
  websocket: WebSocketAPI
  messaging: MessagingAPI
  notification?: any  // Optional notification service
}

/**
 * HTTP API
 */
export interface HttpAPI {
  addRoute(method: string, path: string, handler: RequestHandler): void
  removeRoute(path: string): void
  middleware(name: string): RequestHandler | undefined
}

/**
 * 数据库API
 */
export interface DatabaseAPI {
  query(sql: string, params?: any[]): Promise<any>
  transaction(callback: (trx: any) => Promise<any>): Promise<any>
  model(name: string): any
}

/**
 * 认证授权API
 */
export interface AuthAPI {
  verifyToken(token: string): Promise<any>
  checkPermission(user: any, resource: string, action: string): boolean
  createToken(user: any, options?: any): string
}

/**
 * 事件API
 */
export interface EventAPI {
  on(event: string, handler: Function): void
  once(event: string, handler: Function): void
  emit(event: string, data?: any): void
  off(event: string, handler?: Function): void
}

/**
 * 存储API
 */
export interface StorageAPI {
  upload(file: Buffer, options: any): Promise<string>
  download(fileId: string): Promise<Buffer>
  delete(fileId: string): Promise<void>
  getUrl(fileId: string): string
}

/**
 * 缓存API
 */
export interface CacheAPI {
  get(key: string): Promise<any>
  set(key: string, value: any, ttl?: number): Promise<void>
  delete(key: string): Promise<void>
  clear(): Promise<void>
}

/**
 * 队列API
 */
export interface QueueAPI {
  push(job: any): Promise<string>
  process(type: string, handler: Function): void
  cancel(jobId: string): Promise<void>
}

/**
 * WebSocket API
 */
export interface WebSocketAPI {
  broadcast(event: string, data: any): void
  sendTo(userId: string, event: string, data: any): void
  onConnection(handler: Function): void
}

/**
 * Messaging API (pub/sub with RPC support)
 */
export interface MessagingAPI {
  publish(topic: string, payload: any, opts?: any): void
  subscribe(topic: string, handler: any): string
  subscribePattern(pattern: string, handler: any): string
  unsubscribe(id: string): boolean
  request(topic: string, payload: any, timeoutMs?: number): Promise<any>
  rpcHandler(topic: string, handler: any): string
}

/**
 * 插件通信接口
 */
export interface PluginCommunication {
  call(plugin: string, method: string, ...args: any[]): Promise<any>
  register(name: string, api: Record<string, Function>): void
  on(event: string, handler: Function): void
  emit(event: string, data?: any): void
}

/**
 * 插件存储接口
 */
export interface PluginStorage {
  get(key: string): Promise<any>
  set(key: string, value: any): Promise<void>
  delete(key: string): Promise<void>
  list(): Promise<string[]>
}

/**
 * 日志接口
 */
export interface Logger {
  debug(message: string, meta?: any): void
  info(message: string, meta?: any): void
  warn(message: string, meta?: any): void
  error(message: string, error?: Error): void
}

/**
 * 插件实例
 */
export interface PluginInstance {
  manifest: PluginManifest
  plugin: any
  context: PluginContext
  status: 'loaded' | 'active' | 'inactive' | 'error'
}

/**
 * 插件服务集合
 * 包含所有可用的插件运行时服务
 */
export interface PluginServices {
  cache: any        // Cache service instance
  queue: any        // Queue service instance
  storage: any      // Storage service instance
  scheduler: any    // Scheduler service instance
  notification: any // Notification service instance
  websocket: any    // WebSocket service instance
  security: any     // Security service instance
  validation: any   // Validation service instance
}

/**
 * 插件状态
 */
export enum PluginStatus {
  DISCOVERED = 'discovered',
  LOADING = 'loading',
  INSTALLED = 'installed',
  ENABLED = 'enabled',
  DISABLED = 'disabled',
  UPDATING = 'updating',
  ERROR = 'error'
}

/**
 * 插件能力标识
 */
export enum PluginCapability {
  // Core capabilities
  DATABASE = 'database',
  HTTP = 'http',
  WEBSOCKET = 'websocket',
  STORAGE = 'storage',
  SCHEDULER = 'scheduler',
  NOTIFICATION = 'notification',

  // UI capabilities
  VIEW_PROVIDER = 'view_provider',
  FIELD_TYPE = 'field_type',
  CUSTOM_COMPONENT = 'custom_component',
  MENU_ITEM = 'menu_item',
  TOOLBAR_BUTTON = 'toolbar_button',
  CONTEXT_MENU = 'context_menu',
  SETTINGS_PAGE = 'settings_page',

  // Workflow capabilities
  FORMULA_FUNCTION = 'formula_function',
  TRIGGER_PROVIDER = 'trigger_provider',
  ACTION_PROVIDER = 'action_provider',
  WORKFLOW_NODE = 'workflow_node',

  // API capabilities
  API_ENDPOINT = 'api_endpoint',
  WEBHOOK_HANDLER = 'webhook_handler',

  // Data capabilities
  DATA_SOURCE = 'data_source',
  CACHE_PROVIDER = 'cache_provider',

  // Auth capabilities
  AUTH_PROVIDER = 'auth_provider',
  EXTERNAL_AUTH = 'external_auth',
  PERMISSION_PROVIDER = 'permission_provider',

  // Communication capabilities
  NOTIFICATION_CHANNEL = 'notification_channel',
  EMAIL_TEMPLATE = 'email_template',

  // Background capabilities
  BACKGROUND_TASK = 'background_task',
  SCHEDULED_JOB = 'scheduled_job'
}

/**
 * 插件注册信息
 */
export interface PluginRegistration {
  manifest: PluginManifest
  status: PluginStatus
  installedAt: Date
  enabledAt?: Date
  lastActivated?: Date
  error?: string
  capabilities?: PluginCapability[]
  dependencies?: PluginDependency[]
}

/**
 * 插件依赖
 */
export interface PluginDependency {
  name: string
  version: string
  optional?: boolean
  capabilities?: PluginCapability[]
}

/**
 * 插件事件类型枚举
 */
export enum PluginEventType {
  INSTALLED = 'plugin:installed',
  UNINSTALLED = 'plugin:uninstalled',
  ENABLED = 'plugin:enabled',
  DISABLED = 'plugin:disabled',
  UPDATED = 'plugin:updated',
  ERROR = 'plugin:error',
  ACTIVATED = 'plugin:activated',
  DEACTIVATED = 'plugin:deactivated'
}

/**
 * 插件事件
 */
export interface PluginEvent {
  type: PluginEventType | string
  pluginName: string
  timestamp: Date
  data?: any
}

/**
 * 验证服务接口
 */
export interface ValidationService {
  validate(schema: any, data: any): Promise<boolean>
  validateManifest(manifest: PluginManifest): Promise<boolean>
}

/**
 * 能力权限映射
 */
export const CAPABILITY_PERMISSIONS: Record<PluginCapability, string[]> = {
  [PluginCapability.DATABASE]: ['database.read', 'database.write'],
  [PluginCapability.HTTP]: ['http.request'],
  [PluginCapability.WEBSOCKET]: ['websocket.broadcast', 'websocket.send'],
  [PluginCapability.STORAGE]: ['storage.upload', 'storage.download'],
  [PluginCapability.SCHEDULER]: ['scheduler.schedule'],
  [PluginCapability.NOTIFICATION]: ['notification.send'],
  [PluginCapability.VIEW_PROVIDER]: ['view.register'],
  [PluginCapability.FIELD_TYPE]: ['field.register'],
  [PluginCapability.FORMULA_FUNCTION]: ['formula.register'],
  [PluginCapability.TRIGGER_PROVIDER]: ['trigger.register'],
  [PluginCapability.ACTION_PROVIDER]: ['action.register'],
  [PluginCapability.API_ENDPOINT]: ['api.register'],
  [PluginCapability.MENU_ITEM]: ['menu.register']
}

/**
 * 插件权限白名单
 *
 * 扩展至35+权限，覆盖10个功能类别
 * @version 2.0 - Expanded from 24 to 37 permissions
 */
export const PERMISSION_WHITELIST = [
  // 数据库权限 (4)
  'database.read',
  'database.write',
  'database.transaction',
  'database.*',

  // HTTP权限 (4)
  'http.addRoute',
  'http.removeRoute',
  'http.request',
  'http.middleware',

  // WebSocket权限 (3)
  'websocket.broadcast',
  'websocket.send',
  'websocket.listen',

  // 事件系统权限 (4)
  'events.emit',
  'events.listen',
  'events.on',
  'events.once',
  'events.off',

  // 存储权限 (4) - Renamed from file.* for clarity
  'storage.read',
  'storage.write',
  'storage.delete',
  'storage.list',

  // 缓存权限 (4)
  'cache.read',
  'cache.write',
  'cache.delete',
  'cache.clear',

  // 队列权限 (3)
  'queue.push',
  'queue.process',
  'queue.cancel',

  // 认证权限 (2) - NEW category, read-only for security
  'auth.verify',
  'auth.checkPermission',

  // 通知权限 (3)
  'notification.send',
  'notification.email',
  'notification.webhook',

  // 指标权限 (2) - NEW category for observability
  'metrics.read',
  'metrics.write',

  // Legacy file.* permissions - DEPRECATED, use storage.* instead
  'file.read',
  'file.write',
  'file.delete'
] as const

export type PluginPermission = typeof PERMISSION_WHITELIST[number]

/**
 * 权限组定义 - 用于简化插件配置
 *
 * 注意：这些组主要用于TypeScript/构建脚本中复用
 * plugin.json中仍需展开为具体权限字符串
 *
 * @version 2.0 - Updated with expanded permission whitelist
 */
export const PERMISSION_GROUPS = {
  /**
   * 只读权限组 - 适用于数据分析、监控、报表类插件
   * 提供基础的读取权限和身份验证能力
   */
  readonly: [
    'database.read',
    'storage.read',
    'cache.read',
    'auth.verify',
    'metrics.read'
  ] as const,

  /**
   * 基础权限组 - 适用于简单功能插件、工具类插件
   * 提供基本的读写和HTTP路由能力
   */
  basic: [
    'database.read',
    'http.addRoute',
    'events.emit',
    'cache.read',
    'cache.write',
    'storage.read'
  ] as const,

  /**
   * 标准权限组 - 适用于业务功能插件、集成插件
   * 提供完整的业务开发所需权限
   */
  standard: [
    'database.read',
    'database.write',
    'http.addRoute',
    'websocket.send',
    'events.emit',
    'events.listen',
    'storage.read',
    'storage.write',
    'cache.read',
    'cache.write',
    'queue.push',
    'auth.verify'
  ] as const,

  /**
   * 高级权限组 - 适用于系统管理插件、高级功能插件
   * 提供完整的系统级权限，使用通配符简化配置
   */
  advanced: [
    'database.*',
    'http.addRoute',
    'http.removeRoute',
    'http.request',
    'websocket.broadcast',
    'websocket.send',
    'websocket.listen',
    'events.emit',
    'events.listen',
    'events.on',
    'events.once',
    'storage.read',
    'storage.write',
    'storage.delete',
    'storage.list',
    'cache.read',
    'cache.write',
    'cache.delete',
    'cache.clear',
    'queue.push',
    'queue.process',
    'queue.cancel',
    'auth.verify',
    'auth.checkPermission',
    'notification.send',
    'notification.email',
    'metrics.read',
    'metrics.write'
  ] as const
} as const

export type PermissionGroupName = keyof typeof PERMISSION_GROUPS