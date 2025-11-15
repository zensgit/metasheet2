/**
 * 插件管理器
 * 整合所有插件相关功能的顶层管理器
 */

import { EventEmitter } from 'eventemitter3'
import {
  PluginManifest,
  PluginInstance,
  PluginRegistration,
  PluginServices,
  CoreAPI,
  PluginStatus,
  PluginCapability
} from '../types/plugin'
import { PluginRegistry } from './plugin-registry'
import { PluginLoader } from './plugin-loader'
import { PluginConfigManager } from './plugin-config-manager'
import { PluginServiceFactory, type ServiceFactoryOptions } from './plugin-service-factory'
import { createEnhancedPluginContext } from './enhanced-plugin-context'
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

  constructor(coreAPI: CoreAPI, config: PluginManagerConfig = {}) {
    super()
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

    // 创建注册中心
    this.registry = new PluginRegistry(coreAPI)

    // 创建加载器（支持自定义插件目录）
    this.loader = new PluginLoader(coreAPI, {
      pluginDirs: config.pluginDirectories
    })

    // 创建配置管理器
    this.configManager = new PluginConfigManager(
      config.configStorage === 'database'
        ? PluginConfigManager.createDatabaseStorage(null) // 需要传入实际的db实例
        : PluginConfigManager.createFileSystemStorage(config.configPath)
    )

    this.setupEventListeners()
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
          const registration = await this.registry.registerPlugin(instance.manifest)
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
   * 启动已安装的插件
   */
  async startInstalledPlugins(): Promise<void> {
    const installedPlugins = this.registry.getPluginsByStatus(PluginStatus.INSTALLED)

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
      // 1. 注册插件
      const registration = await this.registry.registerPlugin(manifest)

      // 2. 创建默认配置
      if (manifest.contributes?.configuration) {
        await this.configManager.setConfig(
          manifest.name,
          manifest.contributes.configuration.default || {},
          'system:install'
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
      const registration = this.registry.getPlugin(pluginName)
      if (!registration) {
        throw new Error(`Plugin not found: ${pluginName}`)
      }

      if (registration.status === PluginStatus.ENABLED) {
        this.logger.warn(`Plugin ${pluginName} is already running`)
        return
      }

      // 1. 启用插件
      await this.registry.enablePlugin(pluginName)

      // 2. 创建增强的插件上下文
      if (this.services) {
        const context = createEnhancedPluginContext(
          registration.manifest,
          this.createCoreAPIForPlugin(registration),
          this.services
        )

        // 更新加载器中的插件实例
        const instance = this.loader.getPlugin(pluginName)
        if (instance) {
          instance.context = context
        }
      }

      this.emit('plugin:started', pluginName)
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
      await this.registry.disablePlugin(pluginName)
      this.emit('plugin:stopped', pluginName)
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
      const registration = this.registry.getPlugin(pluginName)
      if (registration && registration.status === PluginStatus.ENABLED) {
        await this.stopPlugin(pluginName)
      }

      // 2. 删除配置
      await this.configManager.deleteConfig(pluginName)

      // 3. 卸载插件
      await this.registry.uninstallPlugin(pluginName)

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
    config: Record<string, any>,
    modifiedBy?: string
  ): Promise<void> {
    try {
      await this.configManager.setConfig(pluginName, config, modifiedBy)

      // 通知插件配置变更
      const instance = this.loader.getPlugin(pluginName)
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
  async getPluginConfig(pluginName: string): Promise<Record<string, any> | null> {
    try {
      const config = await this.configManager.getConfig(pluginName)
      return config?.config || null
    } catch (error) {
      this.logger.error(`Failed to get config for plugin: ${pluginName}`, error as Error)
      throw error
    }
  }

  /**
   * 获取所有插件
   */
  getPlugins(): PluginRegistration[] {
    return this.registry.getAllPlugins()
  }

  /**
   * 获取特定插件
   */
  getPlugin(pluginName: string): PluginRegistration | null {
    return this.registry.getPlugin(pluginName)
  }

  /**
   * 按状态获取插件
   */
  getPluginsByStatus(status: PluginStatus): PluginRegistration[] {
    return this.registry.getPluginsByStatus(status)
  }

  /**
   * 按能力获取插件
   */
  getPluginsByCapability(capability: PluginCapability): PluginRegistration[] {
    return this.registry.getPluginsByCapability(capability)
  }

  /**
   * 获取插件统计信息
   */
  getStats(): {
    total: number
    enabled: number
    disabled: number
    error: number
    capabilities: Record<PluginCapability, number>
    services: Record<string, any>
  } {
    const registryStats = this.registry.getStats()
    const serviceStats = this.services ? {
      cache: (this.services.cache as any).getMetrics?.() || 'N/A',
      queue: 'N/A', // 可以添加队列统计
      websocket: (this.services.websocket as any).getStats?.() || 'N/A',
      security: (this.services.security as any).getStats?.() || 'N/A',
      storage: 'N/A', // 可以添加存储统计
      scheduler: 'N/A', // 可以添加调度器统计
      notification: (this.services.notification as any).getStats?.() || 'N/A',
      validation: 'N/A'
    } : {}

    return {
      ...registryStats,
      services: serviceStats
    }
  }

  /**
   * 获取健康状态
   */
  async getHealth(): Promise<Record<string, any>> {
    const health = {
      manager: {
        status: this.initialized ? 'healthy' : 'initializing',
        initialized: this.initialized
      },
      registry: {
        status: 'healthy',
        pluginCount: this.registry.getAllPlugins().length
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
      const enabledPlugins = this.registry.getPluginsByStatus(PluginStatus.ENABLED)
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

      this.initialized = false
      this.emit('manager:destroyed')
      this.logger.info('Plugin manager destroyed')
    } catch (error) {
      this.logger.error('Error during plugin manager destruction', error as Error)
      throw error
    }
  }

  /**
   * 设置事件监听器
   */
  private setupEventListeners(): void {
    // 注册中心事件
    this.registry.on('plugin:installed', (pluginName: string) => {
      this.emit('plugin:installed', pluginName)
    })

    this.registry.on('plugin:enabled', (pluginName: string) => {
      this.emit('plugin:enabled', pluginName)
    })

    this.registry.on('plugin:disabled', (pluginName: string) => {
      this.emit('plugin:disabled', pluginName)
    })

    this.registry.on('plugin:error', (event: any) => {
      this.emit('plugin:error', event)
    })

    // 加载器事件
    this.loader.on('plugin:loaded', (pluginName: string) => {
      this.emit('plugin:loaded', pluginName)
    })

    this.loader.on('plugin:error', (event: any) => {
      this.emit('plugin:error', event)
    })

    // 配置管理器事件
    this.configManager.on('config:changed', (event: any) => {
      this.emit('plugin:config:changed', event)
    })
  }

  /**
   * 为插件创建CoreAPI实例
   */
  private createCoreAPIForPlugin(registration: PluginRegistration): CoreAPI {
    // 这里可以基于插件的权限和能力创建定制的CoreAPI
    // 目前返回标准的CoreAPI，实际实现中应该注入真实的CoreAPI
    return {} as CoreAPI
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
