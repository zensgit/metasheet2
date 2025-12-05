/**
 * 插件系统核心类型定义
 * Last updated: 2025-11-03 (Batch 1 完成)
 */

import type { RequestHandler } from 'express'

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
  onConfigChange?(config: PluginConfig): void
}

/**
 * 插件配置类型
 */
export type PluginConfig = Record<string, unknown>

// ============================================================
// Contributed Types (for plugin.json contributes section)
// ============================================================

/**
 * 贡献的视图定义
 */
export interface ContributedView {
  id: string
  name: string
  type?: string
  icon?: string
  component?: string
  order?: number
  location?: string
  settings?: Record<string, unknown>
  depends?: string[]  // Capability dependencies
}

/**
 * 贡献的命令定义
 */
export interface ContributedCommand {
  id: string
  title: string
  name?: string  // Optional alternative name
  icon?: string
  category?: string
  when?: string
  handler?: string
}

/**
 * 贡献的菜单定义
 */
export interface ContributedMenus {
  context?: ContributedMenuItem[]
  toolbar?: ContributedMenuItem[]
  main?: ContributedMenuItem[]
  [key: string]: ContributedMenuItem[] | undefined
}

export interface ContributedMenuItem {
  command: string
  group?: string
  when?: string
  order?: number
}

/**
 * 贡献的配置定义
 */
export interface ContributedConfiguration {
  title?: string
  properties?: Record<string, ConfigurationProperty>
  default?: Record<string, unknown>  // Default configuration values
}

export interface ConfigurationProperty {
  type: string
  default?: unknown
  description?: string
  enum?: unknown[]
  minimum?: number
  maximum?: number
}

/**
 * 贡献的字段类型定义
 */
export interface ContributedFieldType {
  id: string
  name: string
  icon?: string
  component?: string
  validator?: string
  formatter?: string
  settings?: Record<string, unknown>
}

/**
 * 贡献的公式定义
 */
export interface ContributedFormula {
  name: string
  description?: string
  category?: string
  parameters?: FormulaParameter[]
  returnType?: string
  handler?: string
}

export interface FormulaParameter {
  name: string
  type: string
  required?: boolean
  description?: string
}

/**
 * 贡献的触发器定义
 */
export interface ContributedTrigger {
  id: string
  name: string
  description?: string
  events?: string[]
  conditions?: TriggerCondition[]
  handler?: string
}

export interface TriggerCondition {
  field: string
  operator: string
  value?: unknown
}

/**
 * 贡献的动作定义
 */
export interface ContributedAction {
  id: string
  name: string
  description?: string
  parameters?: ActionParameter[]
  handler?: string
  depends?: string[]  // Capability dependencies
}

export interface ActionParameter {
  name: string
  type: string
  required?: boolean
  default?: unknown
  description?: string
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
  config: PluginConfig

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

  // Capability declarations (simple string array format)
  capabilities?: string[]

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
    views?: ContributedView[]
    commands?: ContributedCommand[]
    menus?: ContributedMenus
    configuration?: ContributedConfiguration
    fieldTypes?: ContributedFieldType[]
    formulas?: ContributedFormula[]
    triggers?: ContributedTrigger[]
    actions?: ContributedAction[]
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
  notification?: NotificationService  // Optional notification service
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
 * 数据库查询结果
 */
export type DatabaseQueryResult = Record<string, unknown>[]

/**
 * 数据库事务对象
 */
export interface DatabaseTransaction {
  query(sql: string, params?: unknown[]): Promise<DatabaseQueryResult>
  commit(): Promise<void>
  rollback(): Promise<void>
}

/**
 * 数据库模型接口
 */
export interface DatabaseModel {
  find(query?: Record<string, unknown>): Promise<DatabaseQueryResult>
  findOne(query: Record<string, unknown>): Promise<Record<string, unknown> | null>
  create(data: Record<string, unknown>): Promise<Record<string, unknown>>
  update(query: Record<string, unknown>, data: Record<string, unknown>): Promise<number>
  delete(query: Record<string, unknown>): Promise<number>
}

/**
 * 数据库API
 */
export interface DatabaseAPI {
  query(sql: string, params?: unknown[]): Promise<DatabaseQueryResult>
  transaction<T>(callback: (trx: DatabaseTransaction) => Promise<T>): Promise<T>
  model(name: string): DatabaseModel
}

/**
 * 用户信息
 */
export interface UserInfo {
  id: string
  name?: string
  email?: string
  roles?: string[]
  permissions?: string[]
  metadata?: Record<string, unknown>
}

/**
 * Token 选项
 */
export interface TokenOptions {
  expiresIn?: number | string
  issuer?: string
  audience?: string
  subject?: string
}

/**
 * 认证授权API
 */
export interface AuthAPI {
  verifyToken(token: string): Promise<UserInfo | null>
  checkPermission(user: UserInfo, resource: string, action: string): boolean
  createToken(user: UserInfo, options?: TokenOptions): string
}

/**
 * 事件处理器类型
 */
export type EventHandler = (...args: unknown[]) => void | Promise<void>

/**
 * 事件API
 */
export interface EventAPI {
  on(event: string, handler: EventHandler): void
  once(event: string, handler: EventHandler): void
  emit(event: string, data?: unknown): void
  off(event: string, handler?: EventHandler): void
}

/**
 * 存储API
 */
export interface StorageAPI {
  upload(file: Buffer, options: UploadOptions): Promise<string>
  download(fileId: string): Promise<Buffer>
  delete(fileId: string): Promise<void>
  getUrl(fileId: string): string
}

/**
 * 缓存设置选项
 */
export interface CacheSetOptions {
  ttl?: number       // Time to live in seconds
  tags?: string[]    // Tags for cache invalidation
  nx?: boolean       // Only set if not exists
  xx?: boolean       // Only set if exists
}

/**
 * 缓存API
 */
export interface CacheAPI {
  get<T = unknown>(key: string): Promise<T | null>
  set<T = unknown>(key: string, value: T, ttl?: number): Promise<void>
  delete(key: string): Promise<void>
  clear(): Promise<void>
}

/**
 * 缓存服务接口 (完整功能)
 */
export interface CacheService {
  get<T = unknown>(key: string): Promise<T | null>
  set<T = unknown>(key: string, value: T, options?: CacheSetOptions): Promise<void>
  delete(key: string): Promise<void>
  exists(key: string): Promise<boolean>
  mget<T = unknown>(keys: string[]): Promise<(T | null)[]>
  mset<T = unknown>(pairs: Array<{key: string, value: T, options?: CacheSetOptions}>): Promise<void>
  mdel(keys: string[]): Promise<void>
  invalidateByTag(tag: string): Promise<void>
  invalidateByPattern(pattern: string): Promise<void>
  increment(key: string, value?: number): Promise<number>
  expire(key: string, seconds: number): Promise<void>
  ttl(key: string): Promise<number>
  size(): Promise<number>
  clear(): Promise<void>
}

/**
 * 队列作业数据
 */
export interface QueueJobData {
  type: string
  payload?: unknown
  priority?: number
  delay?: number
  retries?: number
}

/**
 * 队列处理器类型
 */
export type QueueProcessor<T = unknown> = (job: Job<T>) => Promise<unknown>

/**
 * 队列API
 */
export interface QueueAPI {
  push<T = unknown>(job: QueueJobData | T): Promise<string>
  process<T = unknown>(type: string, handler: QueueProcessor<T>): void
  cancel(jobId: string): Promise<void>
}

/**
 * WebSocket 连接处理器
 */
export type WebSocketConnectionHandler = (socket: SocketInfo) => void | Promise<void>

/**
 * WebSocket API
 */
export interface WebSocketAPI {
  broadcast(event: string, data: unknown): void
  sendTo(userId: string, event: string, data: unknown): void
  onConnection(handler: WebSocketConnectionHandler): void
}

/**
 * 消息处理器类型
 */
export type MessageHandler<T = unknown, R = void> = (payload: T, topic: string) => R | Promise<R>

/**
 * 消息发布选项
 */
export interface PublishOptions {
  correlationId?: string
  replyTo?: string
  expiration?: number
  priority?: number
}

/**
 * RPC 处理器类型
 */
export type RpcHandler<T = unknown, R = unknown> = (payload: T) => R | Promise<R>

/**
 * Messaging API (pub/sub with RPC support)
 */
export interface MessagingAPI {
  publish<T = unknown>(topic: string, payload: T, opts?: PublishOptions): void
  subscribe<T = unknown>(topic: string, handler: MessageHandler<T>): string
  subscribePattern<T = unknown>(pattern: string, handler: MessageHandler<T>): string
  unsubscribe(id: string): boolean
  request<T = unknown, R = unknown>(topic: string, payload: T, timeoutMs?: number): Promise<R>
  rpcHandler<T = unknown, R = unknown>(topic: string, handler: RpcHandler<T, R>): string
}

/**
 * 插件 API 方法类型
 */
export type PluginApiMethod = (...args: unknown[]) => unknown | Promise<unknown>

/**
 * 插件通信接口
 */
export interface PluginCommunication {
  call<R = unknown>(plugin: string, method: string, ...args: unknown[]): Promise<R>
  register(name: string, api: Record<string, PluginApiMethod>): void
  on(event: string, handler: EventHandler): void
  emit(event: string, data?: unknown): void
}

/**
 * 插件存储接口
 */
export interface PluginStorage {
  get<T = unknown>(key: string): Promise<T | null>
  set<T = unknown>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
  list(): Promise<string[]>
}

/**
 * 日志元数据类型
 */
export type LogMeta = Record<string, unknown>

/**
 * 日志接口
 */
export interface Logger {
  debug(message: string, meta?: LogMeta): void
  info(message: string, meta?: LogMeta): void
  warn(message: string, meta?: LogMeta): void
  error(message: string, error?: Error): void
}

/**
 * 插件实例
 */
export interface PluginInstance {
  manifest: PluginManifest
  plugin: PluginLifecycle
  context: PluginContext
  status: 'loaded' | 'active' | 'inactive' | 'error'
}

/**
 * 插件服务集合
 * 包含所有可用的插件运行时服务
 */
export interface PluginServices {
  cache: CacheService        // Cache service instance
  queue: QueueService        // Queue service instance
  storage: StorageService      // Storage service instance
  scheduler: SchedulerService    // Scheduler service instance
  notification: NotificationService // Notification service instance
  websocket: WebSocketService    // WebSocket service instance
  security: SecurityService     // Security service instance
  validation: ValidationService   // Validation service instance
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
 * 插件事件数据
 */
export type PluginEventData = Record<string, unknown>

/**
 * 插件事件
 */
export interface PluginEvent {
  type: PluginEventType | string
  pluginName: string
  timestamp: Date
  data?: PluginEventData
}

/**
 * 验证 schema 类型
 */
export type ValidationSchemaDefinition = Record<string, unknown>

/**
 * 验证器函数类型
 */
export type ValidatorFunction = (value: unknown) => boolean | string

/**
 * 验证服务接口 (用于插件清单验证)
 */
export interface PluginValidationService {
  validate(schema: ValidationSchemaDefinition, data: unknown): Promise<boolean>
  validateManifest(manifest: PluginManifest): Promise<boolean>
  getValidator?(name: string): ValidatorFunction | undefined
}

/**
 * 能力权限映射
 */
export const CAPABILITY_PERMISSIONS: Partial<Record<PluginCapability, string[]>> = {
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
  [PluginCapability.MENU_ITEM]: ['menu.register'],
  // Additional capabilities with default empty permissions
  [PluginCapability.CUSTOM_COMPONENT]: [],
  [PluginCapability.TOOLBAR_BUTTON]: [],
  [PluginCapability.CONTEXT_MENU]: [],
  [PluginCapability.SETTINGS_PAGE]: [],
  [PluginCapability.WORKFLOW_NODE]: [],
  [PluginCapability.WEBHOOK_HANDLER]: ['http.request'],
  [PluginCapability.DATA_SOURCE]: ['database.read'],
  [PluginCapability.CACHE_PROVIDER]: ['cache.read', 'cache.write'],
  [PluginCapability.AUTH_PROVIDER]: ['auth.verify'],
  [PluginCapability.EXTERNAL_AUTH]: ['auth.verify', 'http.request'],
  [PluginCapability.PERMISSION_PROVIDER]: ['auth.checkPermission'],
  [PluginCapability.NOTIFICATION_CHANNEL]: ['notification.send'],
  [PluginCapability.EMAIL_TEMPLATE]: ['notification.email'],
  [PluginCapability.BACKGROUND_TASK]: ['queue.process'],
  [PluginCapability.SCHEDULED_JOB]: ['scheduler.schedule']
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

// ============================================================
// WebSocket Service Types
// ============================================================

/**
 * WebSocket 服务接口
 */
export interface WebSocketService {
  // Broadcasting
  broadcast(event: string, data: unknown, options?: BroadcastOptions): void
  broadcastToRoom?(room: string, event: string, data: unknown, options?: BroadcastOptions): void

  // Direct messaging
  sendTo(targetId: string, event: string, data: unknown, options?: SendOptions): Promise<boolean> | void
  sendToMany?(targetIds: string[], event: string, data: unknown, options?: SendOptions): Promise<boolean[]>
  sendToUser?(userId: string, event: string, data: unknown, options?: SendOptions): void
  sendToRoom?(room: string, event: string, data: unknown, options?: SendOptions): void

  // Room management
  join?(socketId: string, room: string): Promise<void>
  leave?(socketId: string, room: string): Promise<void>
  joinRoom?(socketId: string, room: string): void
  leaveRoom?(socketId: string, room: string): void
  joinMany?(socketIds: string[], room: string): Promise<void>
  leaveMany?(socketIds: string[], room: string): Promise<void>

  // Socket queries
  getConnectedSockets?(): Promise<SocketInfo[]>
  getSocketInfo?(socketId: string): Promise<SocketInfo | null>
  getRoomSockets(room: string): Promise<SocketInfo[]> | string[]
  getRooms?(): Promise<string[]>
  getSocket?(socketId: string): SocketInfo | undefined
  getUserSockets?(userId: string): string[]

  // Event handling
  onConnection?(handler: (socket: SocketInfo) => void): void
  onDisconnection?(handler: (socket: SocketInfo) => void): void
  onMessage?(event: string, handler: (socket: SocketInfo, data: unknown) => void): void
  use(middleware: SocketMiddleware): void

  // Authentication
  authenticate?(socketId: string, token: string): Promise<boolean>
  authorize?(socketId: string, resource: string, action: string): Promise<boolean>
}

export interface BroadcastOptions {
  rooms?: string[]
  except?: string[]
  volatile?: boolean
  compress?: boolean
  binary?: boolean
}

export interface SendOptions {
  volatile?: boolean
  compress?: boolean
  binary?: boolean
  timeout?: number
}

export interface SocketInfo {
  id: string
  userId?: string
  rooms: string[]
  connected: boolean
  connectedAt: Date
  lastSeen: Date
  metadata: Record<string, unknown>
  updateLastSeen?(): void
}

export type SocketMiddleware = (socket: SocketInfo, next: (err?: Error) => void) => void | Promise<void>

// ============================================================
// Notification Service Types
// ============================================================

export interface NotificationService {
  // Sending notifications
  send(notification: Notification): Promise<NotificationResult>
  sendBulk?(notifications: Notification[]): Promise<NotificationResult[]>
  sendBatch?(notifications: Notification[]): Promise<NotificationResult[]>
  sendTemplate?(templateName: string, recipients: NotificationRecipient[], data: Record<string, unknown>): Promise<NotificationResult>

  // Channel management
  registerChannel(channel: NotificationChannel): void
  unregisterChannel?(channelName: string): void
  getChannels(): NotificationChannel[]

  // Template management
  addTemplate?(template: NotificationTemplate): void
  registerTemplate?(template: NotificationTemplate): void
  removeTemplate?(templateId: string): void
  getTemplate(templateId: string): NotificationTemplate | null | undefined

  // History
  getHistory(options?: NotificationHistoryOptions): Promise<NotificationHistory[]>

  // Subscriptions
  subscribe(userId: string, channel: string, preferences: NotificationPreferences): Promise<void>
  unsubscribe(userId: string, channel: string): Promise<void>
  getSubscriptions?(userId: string): Promise<NotificationSubscription[]>
  getPreferences?(userId: string): Promise<NotificationPreferences>
  updatePreferences?(userId: string, preferences: Partial<NotificationPreferences>): Promise<void>
}

export interface Notification {
  id?: string
  type?: string
  channel?: string           // target channel name
  subject: string
  content: string
  recipients: NotificationRecipient[]
  channels?: string[]
  priority?: 'low' | 'normal' | 'high' | 'urgent'
  templateId?: string
  templateData?: Record<string, unknown>
  data?: unknown                 // additional data
  metadata?: Record<string, unknown>
  scheduledAt?: Date
}

export interface NotificationResult {
  id: string
  status: 'sent' | 'failed' | 'pending' | 'scheduled' | 'cancelled'
  sentAt?: Date
  failedReason?: string
  metadata?: Record<string, unknown>
}

export interface NotificationRecipient {
  id: string
  type: 'user' | 'email' | 'phone' | 'webhook' | 'group'
  metadata?: Record<string, unknown>
}

/**
 * 通知渠道配置
 */
export type NotificationChannelConfig = Record<string, unknown>

export interface NotificationChannel {
  name: string
  type: 'email' | 'sms' | 'push' | 'webhook' | 'in-app' | 'feishu' | string
  config: NotificationChannelConfig
  sender(notification: Notification, recipients: NotificationRecipient[]): Promise<NotificationResult>
}

export interface NotificationTemplate {
  id?: string
  name: string
  channel?: string          // target channel
  subject: string
  content: string
  type?: string
  channels?: string[]
  variables?: string[]
  metadata?: Record<string, unknown>
}

export interface NotificationHistory {
  id: string
  notificationId?: string
  notification?: Notification
  result?: NotificationResult
  channel?: string
  recipient?: string
  status?: string
  sentAt?: Date
  createdAt?: Date
  error?: string
}

export interface NotificationHistoryOptions {
  userId?: string
  channel?: string
  status?: string
  from?: Date
  to?: Date
  dateFrom?: Date      // alias
  dateTo?: Date        // alias
  limit?: number
  offset?: number
}

export interface NotificationSubscription {
  id?: string
  userId?: string
  channel?: string
  type?: string
  channels?: string[]
  enabled?: boolean
  preferences?: NotificationPreferences
  createdAt?: Date
  updatedAt?: Date
}

export interface NotificationPreferences {
  enabled?: boolean
  channels?: Record<string, boolean>
  subscriptions?: NotificationSubscription[]
  quietHours?: { start: string; end: string }
  quiet_hours?: { start: string; end: string; timezone?: string }  // alias with timezone
}

// ============================================================
// Queue Service Types
// ============================================================

export interface QueueService {
  add<T = unknown>(queueName: string, jobName: string, data: T, options?: JobOptions): Promise<Job<T>>
  addBulk<T = unknown>(queueName: string, jobs: Array<{name: string; data: T; options?: JobOptions}>): Promise<Job<T>[]>
  process<T = unknown>(queueName: string, jobName: string, processor: JobProcessor<T>): void
  pause(queueName: string): Promise<void>
  resume(queueName: string): Promise<void>
  empty(queueName: string): Promise<void>
  clean(queueName: string, grace: number, status: JobStatus): Promise<Job[]>
  getJob<T = unknown>(queueName: string, jobId: string): Promise<Job<T> | null>
  removeJob(queueName: string, jobId: string): Promise<void>
  retryJob(queueName: string, jobId: string): Promise<void>
  getQueueStatus(queueName: string): Promise<QueueStatus>
  onQueueEvent(queueName: string, event: QueueEventType, handler: (job: Job, result?: unknown) => void): void
  offQueueEvent(queueName: string, event: QueueEventType, handler?: (...args: unknown[]) => void): void
}

export interface Job<T = unknown> {
  id: string
  name: string
  data: T
  progress: number
  attempts?: number        // deprecated, use attemptsMade
  attemptsMade?: number    // number of attempts made
  delay?: number
  timestamp: number
  processedOn?: number
  finishedOn?: number
  failedReason?: string
  returnvalue?: unknown
  returnValue?: unknown        // alias for returnvalue
  options?: JobOptions     // job options
}

export interface JobOptions {
  delay?: number
  attempts?: number
  backoff?: string | number | { type: 'fixed' | 'exponential'; delay: number }
  priority?: number
  timeout?: number
  removeOnComplete?: boolean | number
  removeOnFail?: boolean | number
  jobId?: string
  repeat?: JobRepeatOptions  // Bull/BullMQ repeat options
}

/**
 * 任务重复选项
 */
export interface JobRepeatOptions {
  cron?: string
  every?: number
  limit?: number
  startDate?: Date | string | number
  endDate?: Date | string | number
  count?: number
  pattern?: string
}

export type JobProcessor<T = unknown> = (job: Job<T>) => Promise<unknown>

export type JobStatus = 'completed' | 'failed' | 'delayed' | 'active' | 'waiting'

export type QueueEventType = 'completed' | 'failed' | 'progress' | 'active' | 'stalled' | 'waiting'

export interface QueueStatus {
  name?: string
  paused?: boolean
  waiting: number
  active: number
  completed: number
  failed: number
  delayed: number
}

// ============================================================
// Scheduler Service Types
// ============================================================

export interface SchedulerService {
  // Core scheduling methods
  schedule(name: string, cronExpression: string, handler: ScheduleHandler, options?: ScheduleOptions): Promise<ScheduledJob>
  scheduleOnce?(id: string, date: Date, handler: ScheduleHandler, options?: ScheduleOptions): ScheduledJob
  scheduleInterval?(id: string, interval: number, handler: ScheduleHandler, options?: ScheduleOptions): ScheduledJob
  delay?(name: string, delay: number, handler: ScheduleHandler, options?: ScheduleOptions): Promise<ScheduledJob>

  // Job management
  unschedule?(name: string): Promise<void>
  reschedule?(name: string, cronExpression: string): Promise<void>
  cancel?(id: string): boolean
  pause(name: string): Promise<void> | boolean
  resume(name: string): Promise<void> | boolean
  trigger?(name: string): Promise<void>

  // Job queries
  getJob(name: string): Promise<ScheduledJob | null> | ScheduledJob | undefined
  getAllJobs?(): ScheduledJob[]
  listJobs?(): Promise<ScheduledJob[]>
  getJobsByPlugin?(pluginName: string): ScheduledJob[]

  // Event handling
  onScheduleEvent(event: ScheduleEventType, handler: (job: ScheduledJob, result?: unknown, error?: Error) => void): void
  offScheduleEvent(event: ScheduleEventType, handler?: (...args: unknown[]) => void): void
}

export interface ScheduledJob {
  id?: string
  name?: string                // job name (used in implementation)
  expression?: string
  cronExpression?: string      // alias for expression
  interval?: number
  delay?: number               // delay in ms for one-time jobs
  runAt?: Date
  nextRun?: Date
  lastRun?: Date
  status?: 'active' | 'paused' | 'completed' | 'cancelled'
  runCount: number
  isRunning?: boolean
  isPaused?: boolean
  options?: ScheduleOptions
  handler?: ScheduleHandler    // job handler function
}

export interface ScheduleOptions {
  timezone?: string
  runImmediately?: boolean
  runOnInit?: boolean       // alias for runImmediately
  startDate?: Date          // when to start scheduling
  maxRuns?: number
  retryOnError?: boolean
  retryDelay?: number
  metadata?: Record<string, unknown>
  context?: unknown             // context passed to handler
}

export type ScheduleHandler = (context?: unknown) => Promise<unknown> | unknown

export type ScheduleEventType = 'run' | 'running' | 'completed' | 'failed' | 'cancelled' | 'paused' | 'resumed' | 'scheduled'

// ============================================================
// Storage Service Types
// ============================================================

export interface StorageService {
  upload(file: Buffer | NodeJS.ReadableStream, options: UploadOptions): Promise<StorageFile>
  download(fileId: string): Promise<Buffer>
  delete(fileId: string): Promise<void>
  exists(fileId: string): Promise<boolean>
  getFileInfo(fileId: string): Promise<StorageFile | null>
  getFileUrl(fileId: string, options?: GetUrlOptions): Promise<string>
  getPresignedUploadUrl(options: PresignedUploadOptions): Promise<PresignedUpload>
  listFiles(prefix?: string, options?: ListOptions): Promise<StorageFile[]>
  createFolder(path: string): Promise<void>
  deleteFolder(path: string, recursive?: boolean): Promise<void>
  getStorageUsage(): Promise<StorageUsage>
}

export interface StorageFile {
  id: string
  name?: string
  filename?: string    // alias for name
  path: string
  url?: string         // file URL
  size: number
  mimeType?: string
  contentType?: string // alias for mimeType
  createdAt: Date
  updatedAt: Date
  metadata?: Record<string, unknown>
  tags?: Record<string, string>
}

export interface UploadOptions {
  filename?: string
  path?: string
  mimeType?: string
  contentType?: string // alias for mimeType
  metadata?: Record<string, unknown>
  tags?: Record<string, string>
  public?: boolean
  overwrite?: boolean
}

export interface GetUrlOptions {
  expiresIn?: number
  download?: boolean
  inline?: boolean
}

export interface PresignedUploadOptions {
  filename: string
  mimeType?: string
  contentType?: string // alias for mimeType
  maxSize?: number
  expiresIn?: number
}

export interface PresignedUpload {
  url?: string
  uploadUrl?: string   // alias for url
  fileId?: string
  fields?: Record<string, string>
  expiresAt?: Date
}

export interface ListOptions {
  limit?: number
  offset?: number
  recursive?: boolean
  sortBy?: 'name' | 'size' | 'createdAt' | 'updatedAt'
  sortOrder?: 'asc' | 'desc'
  filter?: {
    contentType?: string
    sizeMin?: number
    sizeMax?: number
    createdAfter?: Date
    createdBefore?: Date
  }
}

export interface StorageUsage {
  used?: number
  totalSize?: number    // alias for used
  total?: number
  totalFiles?: number
  fileCount?: number    // alias for totalFiles
  usedQuota?: number
  availableQuota?: number
}

// ============================================================
// Security Service Types
// ============================================================

export interface SecurityService {
  // Sandbox management
  createSandbox(pluginName: string, allowedAPIs?: string[], limits?: ResourceLimits): PluginSandbox
  getSandbox?(pluginName: string): PluginSandbox | null

  // Permission checking
  checkPermission?(pluginName: string, permission: string): Promise<boolean>
  checkPermissions?(pluginName: string, permissions: string[]): Promise<boolean[]>
  validateAPIAccess?(pluginName: string, apiPath: string, method: string): Promise<boolean>

  // Cryptography
  encrypt(data: string, key?: string): Promise<string>
  decrypt(data: string, key?: string): Promise<string>
  hash(data: string, algorithm?: string): string | Promise<string>
  verify?(data: string, hash: string, algorithm?: string): Promise<boolean>
  verifyHash?(data: string, hash: string, algorithm?: string): boolean

  // Token & Security
  generateToken?(length?: number): string

  // Threat scanning
  scanForThreats(pluginName: string, code: string): Promise<ThreatScanResult>

  // Rate limiting
  rateLimit?(key: string, limit: number, window: number): Promise<RateLimitResult>
  checkRateLimit?(pluginName: string, resource: string): Promise<RateLimitResult>

  // Resource monitoring
  monitorResource?(pluginName: string, resource: string, usage: ResourceUsage): Promise<void>
  getResourceUsage?(pluginName: string): Promise<ResourceUsage[]>

  // Audit
  audit(event: SecurityAuditEvent): Promise<void>
  getAuditLog?(options?: AuditLogOptions): Promise<SecurityAuditEvent[]>
  getAuditLogs?(options?: AuditLogOptions): Promise<SecurityAuditEvent[]>
}

export interface PluginSandbox {
  pluginName: string
  allowedAPIs: string[]
  resourceLimits: ResourceLimits
  environment: Record<string, unknown>
  execute<T>(code: string, context?: Record<string, unknown>): Promise<T>
  getResourceUsage?(): ResourceUsage
  destroy?(): void
}

export interface ResourceLimits {
  maxMemory?: number
  memory?: number       // alias
  maxCpu?: number
  cpu?: number          // alias
  maxExecutionTime?: number
  maxNetworkRequests?: number
  network?: number      // alias
  maxFileOperations?: number
  disk?: number         // alias
  database?: number     // database query limit per minute
}

export interface ResourceUsage {
  memory?: number
  cpu?: number
  executionTime?: number
  networkRequests?: number
  fileOperations?: number
  timestamp?: Date
  current?: number      // current usage value
  limit?: number        // limit value
  unit?: string         // unit of measurement
}

export interface ThreatScanResult {
  safe: boolean
  threats: Array<{
    type: string
    severity: 'low' | 'medium' | 'high' | 'critical'
    description: string
    location?: { line: number; column: number }
    line?: number    // direct line number
    column?: number  // direct column number
  }>
}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  resetAt?: Date
  resetTime?: Date  // alias for resetAt
  retryAfter?: number  // seconds to wait
}

export interface SecurityAuditEvent {
  id?: string
  type?: string
  event?: string        // alias for type
  pluginName?: string
  action?: string
  actor?: string
  userId?: string       // alias for actor
  resource?: string
  details?: Record<string, unknown>
  metadata?: Record<string, unknown>  // alias for details
  timestamp?: Date
  severity?: 'info' | 'warning' | 'error' | 'critical'
  ipAddress?: string
  userAgent?: string
}

export interface AuditLogOptions {
  type?: string
  event?: string        // alias for type
  pluginName?: string
  actor?: string
  userId?: string       // alias for actor
  severity?: string
  from?: Date
  to?: Date
  dateFrom?: Date       // alias for from
  dateTo?: Date         // alias for to
  limit?: number
  offset?: number
}

// ============================================================
// Validation Service Types
// ============================================================

export interface ValidationService {
  string(): StringSchema
  number(): NumberSchema
  boolean(): BooleanSchema
  object<T = unknown>(): ObjectSchema<T>
  array<T = unknown>(): ArraySchema<T>
  union<T = unknown>(): UnionSchema<T>
  optional<T>(schema: ValidationSchema<T>): OptionalSchema<T>
  validate<T>(data: unknown, schema: ValidationSchema<T>): Promise<ValidationResult<T>>
  validateSync<T>(data: unknown, schema: ValidationSchema<T>): ValidationResult<T>
  registerSchema<T>(name: string, schema: ValidationSchema<T>): void
  getSchema<T>(name: string): ValidationSchema<T> | null
  addValidator(name: string, validator: CustomValidator): void
  getValidator(name: string): CustomValidator | null
  transform<T>(data: unknown, transformer: DataTransformer<T>): Promise<T>
  validateBatch<T>(items: unknown[], schema: ValidationSchema<T>): Promise<ValidationResult<T>[]>
}

export interface ValidationSchema<T = unknown> {
  parse(data: unknown): T
  safeParse(data: unknown): ValidationResult<T>
  optional(): ValidationSchema<T | undefined>
  nullable(): ValidationSchema<T | null>
  default(value: T): ValidationSchema<T>
  transform<U>(fn: (value: T) => U): ValidationSchema<U>
}

export interface ValidationResult<T> {
  success: boolean
  data?: T
  errors?: ValidationError[]
}

export interface ValidationError {
  path: string[]
  message: string
  code?: string
  expected?: string
  received?: string
}

export type CustomValidator = (value: unknown) => boolean | string

export type DataTransformer<T = unknown> = (data: unknown) => T

export interface StringSchema extends ValidationSchema<string> {
  min(length: number): StringSchema
  max(length: number): StringSchema
  length(length: number): StringSchema
  email(): StringSchema
  url(): StringSchema
  uuid(): StringSchema
  regex(pattern: RegExp): StringSchema
}

export interface NumberSchema extends ValidationSchema<number> {
  min(value: number): NumberSchema
  max(value: number): NumberSchema
  int(): NumberSchema
  positive(): NumberSchema
  negative(): NumberSchema
  nonnegative(): NumberSchema
}

export interface BooleanSchema extends ValidationSchema<boolean> {}

export interface ObjectSchema<T = unknown> extends ValidationSchema<T> {
  shape<S>(shape: { [K in keyof S]: ValidationSchema<S[K]> }): ObjectSchema<S>
  pick<K extends keyof T>(keys: K[]): ObjectSchema<Pick<T, K>>
  omit<K extends keyof T>(keys: K[]): ObjectSchema<Omit<T, K>>
  partial(): ObjectSchema<Partial<T>>
  required(): ObjectSchema<Required<T>>
  strict(): ObjectSchema<T>
}

export interface ArraySchema<T = unknown> extends ValidationSchema<T[]> {
  element<U>(schema: ValidationSchema<U>): ArraySchema<U>
  min(length: number): ArraySchema<T>
  max(length: number): ArraySchema<T>
  length(length: number): ArraySchema<T>
  nonempty(): ArraySchema<T>
}

export interface UnionSchema<T = unknown> extends ValidationSchema<T> {
  or<U>(schema: ValidationSchema<U>): UnionSchema<T | U>
}

export interface OptionalSchema<T = unknown> extends ValidationSchema<T | undefined> {}