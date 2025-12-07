/**
 * 插件管理器
 * 整合所有插件相关功能的顶层管理器
 */

import { EventEmitter } from 'eventemitter3'
import type {
  PluginCapability
} from '../types/plugin';
import {
  type PluginManifest,
  type PluginRegistration,
  type PluginServices,
  type CoreAPI,
  PluginStatus
} from '../types/plugin'
import { PluginRegistry, type PluginRegistrationWithId } from './plugin-registry'
import { PluginLoader, type LoadedPlugin } from './plugin-loader'
import { PluginConfigManager } from './plugin-config-manager'
import { PluginServiceFactory, type ServiceFactoryOptions } from './plugin-service-factory'
import { createEnhancedPluginContext, type EnhancedPluginContext } from './enhanced-plugin-context'
import { Logger } from './logger'

/**
 * 插件管理器配置
 */
export interface PluginManagerConfig {
  // 插件目录
  pluginDirectories?: string[]

  // 服务配置
  services?: ServiceFactoryOptions

  // 配置存储
  configStorage?: 'file' | 'database'
  configPath?: string

  // 安全设置
  security?: {
    enableSandbox?: boolean
    allowUnsafePlugins?: boolean
  }

  // 自动加载设置
  autoLoad?: boolean
  autoStart?: boolean
}

/**
 * 服务统计信息
 */
interface ServiceStats {
  cache?: unknown
  queue?: unknown
  websocket?: unknown
  security?: unknown
  storage?: unknown
  scheduler?: unknown
  notification?: unknown
  validation?: unknown
}

/**
 * 健康检查结果
 */
interface HealthCheckResult {
  manager: {
    status: 'healthy' | 'initializing' | 'error'
    initialized: boolean
  }
  registry: {
    status: 'healthy' | 'error'
    pluginCount: number
  }
  services: Record<string, unknown> | null
}

/**
 * 扩展的 LoadedPlugin，包含可选的 context
 * Exported for use by plugin extensions
 */
export interface LoadedPluginWithContext extends LoadedPlugin {
  context?: EnhancedPluginContext
}

/**
 * 插件管理器
 */
export class PluginManager extends EventEmitter {
  private registry: PluginRegistry
  private loader: PluginLoader
  private configManager: PluginConfigManager
  private serviceFactory: PluginServiceFactory
  private services: PluginServices | null = null
  private config: PluginManagerConfig
  private logger: Logger
  private initialized = false
  // Store plugin contexts separately since LoadedPlugin doesn't have context
  private pluginContexts: Map<string, EnhancedPluginContext> = new Map()
  // Store the CoreAPI for plugin injection
  private coreAPI: CoreAPI

  constructor(coreAPI: CoreAPI, config: PluginManagerConfig = {}) {
    super()
    this.coreAPI = coreAPI
    this.config = {
      autoLoad: true,
      autoStart: true,
      configStorage: 'file',
      security: {
        enableSandbox: true,
        allowUnsafePlugins: false
      },
      ...config
    }
    this.logger = new Logger('PluginManager')

    // 创建服务工厂
    this.serviceFactory = new PluginServiceFactory(config.services)

    // 创建注册中心 (PluginRegistry 不接受参数)
    this.registry = new PluginRegistry()

    // 创建加载器 (PluginLoader 接受可选的 basePath 或 CoreAPI)
    this.loader = new PluginLoader(config.pluginDirectories?.[0] || './plugins')

    // 创建配置管理器 (PluginConfigManager 不接受参数)
    this.configManager = new PluginConfigManager()

    // 注意: setupEventListeners 已移除，因为这些类不是 EventEmitter
  }

  /**
   * 初始化插件管理器
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      this.logger.warn('Plugin manager already initialized')
      return
    }

    this.logger.info('Initializing plugin manager...')

    try {
      // 1. 创建服务实例
      this.services = await this.serviceFactory.createServices()
      this.logger.info('Plugin services initialized')

      // 2. 如果启用自动加载，扫描并加载插件
      if (this.config.autoLoad) {
        await this.discoverPlugins()
      }

      // 3. 如果启用自动启动，启动所有已安装的插件
      if (this.config.autoStart) {
        await this.startInstalledPlugins()
      }

      this.initialized = true
      this.emit('manager:initialized')
      this.logger.info('Plugin manager initialized successfully')
    } catch (error) {
      this.logger.error('Failed to initialize plugin manager', error as Error)
      throw error
    }
  }

  /**
   * 发现插件
   */
  async discoverPlugins(): Promise<PluginRegistration[]> {
    this.logger.info('Discovering plugins...')

    try {
      // 使用加载器扫描插件
      await this.loader.loadPlugins()

      // 将发现的插件注册到注册中心
      const loadedPlugins = this.loader.getPlugins()
      const registrations: PluginRegistration[] = []

      for (const [name, instance] of loadedPlugins) {
        try {
          // 创建 PluginRegistration 并注册
          const registration = this.createRegistrationFromManifest(instance.manifest)
          this.registry.register(registration)
          registrations.push(registration)
          this.logger.info(`Discovered and registered plugin: ${name}`)
        } catch (error) {
          this.logger.error(`Failed to register discovered plugin: ${name}`, error as Error)
        }
      }

      this.emit('plugins:discovered', registrations)
      return registrations
    } catch (error) {
      this.logger.error('Failed to discover plugins', error as Error)
      throw error
    }
  }

  /**
   * 从 manifest 创建 PluginRegistration
   */
  private createRegistrationFromManifest(manifest: PluginManifest): PluginRegistration {
    return {
      manifest,
      status: PluginStatus.INSTALLED,
      installedAt: new Date(),
      capabilities: this.extractCapabilities(manifest)
    }
  }

  /**
   * 从 manifest 提取能力列表
   */
  private extractCapabilities(manifest: PluginManifest): PluginCapability[] {
    // manifest.capabilities 是 string[] | undefined
    if (!manifest.capabilities) return []
    // 将 string[] 转换为 PluginCapability[]
    return manifest.capabilities as unknown as PluginCapability[]
  }

  /**
   * 启动已安装的插件
   */
  async startInstalledPlugins(): Promise<void> {
    const installedPlugins = this.registry.getByStatus(PluginStatus.INSTALLED)

    for (const registration of installedPlugins) {
      try {
        await this.startPlugin(registration.manifest.name)
      } catch (error) {
        this.logger.error(`Failed to start plugin: ${registration.manifest.name}`, error as Error)
      }
    }
  }

  /**
   * 安装插件
   */
  async installPlugin(manifest: PluginManifest): Promise<PluginRegistration> {
    this.logger.info(`Installing plugin: ${manifest.name}`)

    try {
      // 1. 创建并注册插件
      const registration = this.createRegistrationFromManifest(manifest)
      this.registry.register(registration)

      // 2. 创建默认配置
      if (manifest.contributes?.configuration) {
        this.configManager.set(
          manifest.name,
          manifest.contributes.configuration.default || {}
        )
      }

      this.emit('plugin:installed', registration)
      return registration
    } catch (error) {
      this.logger.error(`Failed to install plugin: ${manifest.name}`, error as Error)
      throw error
    }
  }

  /**
   * 启动插件
   */
  async startPlugin(pluginName: string): Promise<void> {
    this.logger.info(`Starting plugin: ${pluginName}`)

    try {
      const registration = this.registry.get(pluginName)
      if (!registration) {
        throw new Error(`Plugin not found: ${pluginName}`)
      }

      if (registration.status === PluginStatus.ENABLED) {
        this.logger.warn(`Plugin ${pluginName} is already running`)
        return
      }

      // 1. 更新插件状态为 ENABLED
      this.registry.updateStatus(pluginName, PluginStatus.ENABLED)

      // 2. 创建增强的插件上下文
      if (this.services) {
        const context = createEnhancedPluginContext({
          manifest: registration.manifest,
          core: this.createCoreAPIForPlugin(registration),
          services: this.services,
          capabilities: {}
        })

        // 存储插件上下文
        this.pluginContexts.set(pluginName, context)
      }

      this.emit('plugin:started', pluginName)
      this.emit('plugin:enabled', pluginName)
    } catch (error) {
      this.logger.error(`Failed to start plugin: ${pluginName}`, error as Error)
      throw error
    }
  }

  /**
   * 停止插件
   */
  async stopPlugin(pluginName: string): Promise<void> {
    this.logger.info(`Stopping plugin: ${pluginName}`)

    try {
      // 更新状态为 DISABLED
      this.registry.updateStatus(pluginName, PluginStatus.DISABLED)
      // 清理上下文
      this.pluginContexts.delete(pluginName)
      this.emit('plugin:stopped', pluginName)
      this.emit('plugin:disabled', pluginName)
    } catch (error) {
      this.logger.error(`Failed to stop plugin: ${pluginName}`, error as Error)
      throw error
    }
  }

  /**
   * 卸载插件
   */
  async uninstallPlugin(pluginName: string): Promise<void> {
    this.logger.info(`Uninstalling plugin: ${pluginName}`)

    try {
      // 1. 停止插件
      const registration = this.registry.get(pluginName)
      if (registration && registration.status === PluginStatus.ENABLED) {
        await this.stopPlugin(pluginName)
      }

      // 2. 删除配置
      this.configManager.delete(pluginName)

      // 3. 从注册中心移除
      this.registry.unregister(pluginName)

      // 4. 从加载器卸载
      this.loader.unload(pluginName)

      this.emit('plugin:uninstalled', pluginName)
    } catch (error) {
      this.logger.error(`Failed to uninstall plugin: ${pluginName}`, error as Error)
      throw error
    }
  }

  /**
   * 更新插件配置
   */
  async updatePluginConfig(
    pluginName: string,
    config: Record<string, unknown>,
    _modifiedBy?: string
  ): Promise<void> {
    try {
      // PluginConfigManager.set 只接受 2 个参数
      this.configManager.set(pluginName, config)

      // 通知插件配置变更
      const instance = this.loader.get(pluginName)
      if (instance && instance.plugin.onConfigChange) {
        instance.plugin.onConfigChange(config)
      }

      this.emit('plugin:config:updated', { pluginName, config })
    } catch (error) {
      this.logger.error(`Failed to update config for plugin: ${pluginName}`, error as Error)
      throw error
    }
  }

  /**
   * 获取插件配置
   */
  async getPluginConfig(pluginName: string): Promise<Record<string, unknown> | null> {
    try {
      const config = this.configManager.get(pluginName)
      return config || null
    } catch (error) {
      this.logger.error(`Failed to get config for plugin: ${pluginName}`, error as Error)
      throw error
    }
  }

  /**
   * 获取所有插件
   */
  getPlugins(): PluginRegistration[] {
    return this.registry.getAll()
  }

  /**
   * 获取特定插件
   */
  getPlugin(pluginName: string): PluginRegistration | null {
    return this.registry.get(pluginName) || null
  }

  /**
   * 按状态获取插件
   */
  getPluginsByStatus(status: PluginStatus): PluginRegistration[] {
    return this.registry.getByStatus(status)
  }

  /**
   * 按能力获取插件
   * 注意: PluginRegistry 没有 getByCapability 方法，需要手动过滤
   */
  getPluginsByCapability(capability: PluginCapability): PluginRegistration[] {
    return this.registry.getAll().filter(reg =>
      reg.capabilities?.includes(capability)
    )
  }

  /**
   * 获取插件统计信息
   */
  getStats(): {
    total: number
    enabled: number
    disabled: number
    error: number
    capabilities: Record<string, number>
    services: ServiceStats
  } {
    const allPlugins = this.registry.getAll()
    const enabledPlugins = this.registry.getByStatus(PluginStatus.ENABLED)
    const disabledPlugins = this.registry.getByStatus(PluginStatus.DISABLED)
    const errorPlugins = this.registry.getByStatus(PluginStatus.ERROR)

    // 统计能力
    const capabilityCount: Record<string, number> = {}
    for (const plugin of allPlugins) {
      if (plugin.capabilities) {
        for (const cap of plugin.capabilities) {
          capabilityCount[cap] = (capabilityCount[cap] || 0) + 1
        }
      }
    }

    const serviceStats: ServiceStats = this.services ? {
      cache: this.hasMethod(this.services.cache, 'getMetrics')
        ? (this.services.cache as unknown as { getMetrics(): unknown }).getMetrics()
        : 'N/A',
      queue: 'N/A',
      websocket: this.hasMethod(this.services.websocket, 'getStats')
        ? (this.services.websocket as unknown as { getStats(): unknown }).getStats()
        : 'N/A',
      security: this.hasMethod(this.services.security, 'getStats')
        ? (this.services.security as unknown as { getStats(): unknown }).getStats()
        : 'N/A',
      storage: 'N/A',
      scheduler: 'N/A',
      notification: this.hasMethod(this.services.notification, 'getStats')
        ? (this.services.notification as unknown as { getStats(): unknown }).getStats()
        : 'N/A',
      validation: 'N/A'
    } : {}

    return {
      total: allPlugins.length,
      enabled: enabledPlugins.length,
      disabled: disabledPlugins.length,
      error: errorPlugins.length,
      capabilities: capabilityCount,
      services: serviceStats
    }
  }

  /**
   * 类型安全的方法检查辅助函数
   */
  private hasMethod(obj: unknown, methodName: string): boolean {
    return typeof obj === 'object' &&
           obj !== null &&
           methodName in obj &&
           typeof (obj as Record<string, unknown>)[methodName] === 'function'
  }

  /**
   * 获取健康状态
   */
  async getHealth(): Promise<HealthCheckResult> {
    const health: HealthCheckResult = {
      manager: {
        status: this.initialized ? 'healthy' : 'initializing',
        initialized: this.initialized
      },
      registry: {
        status: 'healthy',
        pluginCount: this.registry.count()
      },
      services: this.serviceFactory ? await this.serviceFactory.getHealth() : null
    }

    return health
  }

  /**
   * 销毁插件管理器
   */
  async destroy(): Promise<void> {
    this.logger.info('Destroying plugin manager...')

    try {
      // 停止所有运行的插件
      const enabledPlugins = this.registry.getByStatus(PluginStatus.ENABLED)
      for (const plugin of enabledPlugins) {
        try {
          await this.stopPlugin(plugin.manifest.name)
        } catch (error) {
          this.logger.error(`Error stopping plugin ${plugin.manifest.name}`, error as Error)
        }
      }

      // 销毁服务
      if (this.serviceFactory) {
        await this.serviceFactory.destroy()
      }

      // 清理上下文
      this.pluginContexts.clear()

      this.initialized = false
      this.emit('manager:destroyed')
      this.logger.info('Plugin manager destroyed')
    } catch (error) {
      this.logger.error('Error during plugin manager destruction', error as Error)
      throw error
    }
  }

  /**
   * 为插件创建CoreAPI实例
   *
   * Creates a CoreAPI instance for a plugin with optional permission scoping.
   * Future enhancement: Filter API access based on manifest.permissions
   */
  private createCoreAPIForPlugin(registration: PluginRegistrationWithId | PluginRegistration): CoreAPI {
    const pluginName = registration.manifest.name

    // Create a scoped CoreAPI that wraps the base CoreAPI
    // This allows us to add plugin-specific logging, metrics, and permission checks
    const scopedAPI: CoreAPI = {
      ...this.coreAPI,

      // Wrap http to add plugin context to routes
      http: {
        ...this.coreAPI.http,
        addRoute: (method: string, path: string, handler) => {
          // Prefix routes with plugin namespace for isolation
          const scopedPath = `/plugins/${pluginName}${path.startsWith('/') ? path : '/' + path}`
          this.logger.debug(`Plugin ${pluginName} registering route: ${method} ${scopedPath}`)
          return this.coreAPI.http.addRoute(method, scopedPath, handler)
        }
      },

      // Wrap cache with plugin-specific key prefix
      cache: {
        get: async <T = unknown>(key: string) => {
          return this.coreAPI.cache.get<T>(`plugin:${pluginName}:${key}`)
        },
        set: async <T = unknown>(key: string, value: T, ttl?: number) => {
          return this.coreAPI.cache.set(`plugin:${pluginName}:${key}`, value, ttl)
        },
        delete: async (key: string) => {
          return this.coreAPI.cache.delete(`plugin:${pluginName}:${key}`)
        },
        clear: async () => {
          // Note: This would ideally only clear plugin-specific keys
          this.logger.warn(`Plugin ${pluginName} requested cache clear - clearing all cache`)
          return this.coreAPI.cache.clear()
        }
      },

      // Wrap events with plugin namespace
      events: {
        ...this.coreAPI.events,
        emit: (event: string, data?: unknown) => {
          // Emit with plugin namespace for traceability
          this.coreAPI.events.emit(`plugin:${pluginName}:${event}`, data)
          // Also emit the original event for cross-plugin communication
          return this.coreAPI.events.emit(event, data)
        }
      }
    }

    return scopedAPI
  }
}

/**
 * 创建插件管理器的便捷方法
 */
export async function createPluginManager(
  coreAPI: CoreAPI,
  config?: PluginManagerConfig
): Promise<PluginManager> {
  const manager = new PluginManager(coreAPI, config)
  await manager.initialize()
  return manager
}
