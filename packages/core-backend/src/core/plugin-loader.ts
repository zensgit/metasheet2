/**
 * 插件加载器
 */

import * as path from 'path'
import * as fs from 'fs/promises'
import { glob } from 'glob'
import { EventEmitter } from 'eventemitter3'
import type {
  PluginInstance,
  PluginManifest,
  PluginContext,
  PluginLifecycle,
  CoreAPI
} from '../types/plugin'
import { createPluginContext } from './plugin-context'
import { Logger } from './logger'
import { ManifestValidator } from './PluginManifestValidator'

export class PluginLoader extends EventEmitter {
  private plugins = new Map<string, PluginInstance>()
  private loadOrder: string[] = []
  private coreAPI: CoreAPI
  private logger: Logger
  private manifestValidator: ManifestValidator

  constructor(coreAPI: CoreAPI) {
    super()
    this.coreAPI = coreAPI
    this.logger = new Logger('PluginLoader')
    this.manifestValidator = new ManifestValidator()
  }

  /**
   * 加载所有插件
   */
  async loadPlugins(): Promise<void> {
    this.logger.info('Starting plugin loading...')

    try {
      // 1. 扫描插件目录
      const pluginDirs = await this.scanPluginDirectories()
      this.logger.info(`Found ${pluginDirs.length} plugin directories`)

      // 2. 读取所有插件配置
      const manifests = await this.loadManifests(pluginDirs)
      this.logger.info(`Loaded ${manifests.length} plugin manifests`)

      // 3. 验证插件
      const validManifests = manifests.filter(m => this.validateManifest(m))
      this.logger.info(`${validManifests.length} plugins passed validation`)

      // 4. 解析依赖关系并排序
      const sortedManifests = this.topologicalSort(validManifests)

      // 5. 按序加载插件
      for (const manifest of sortedManifests) {
        await this.loadPlugin(manifest)
      }

      // 6. 激活所有插件
      await this.activatePlugins()

      this.logger.info(`Successfully loaded ${this.plugins.size} plugins`)
    } catch (error) {
      this.logger.error('Failed to load plugins', error as Error)
      throw error
    }
  }

  /**
   * 扫描插件目录
   */
  private async scanPluginDirectories(): Promise<string[]> {
    // Look for plugins in metasheet-v2 root (all plugins/*) and installed namespace packages
    const rootDir = path.resolve(process.cwd(), '../../')
    const patterns = [
      path.join(rootDir, 'plugins', '*'),
      path.join(process.cwd(), 'node_modules', '@metasheet', 'plugin-*')
    ]

    const dirs: string[] = []
    for (const pattern of patterns) {
      try {
        const matches = await glob(pattern)
        // Filter to only directories
        const dirMatches = []
        for (const match of matches) {
          const stat = await import('fs').then(fs => fs.promises.stat(match))
          if (stat.isDirectory()) {
            dirMatches.push(match)
          }
        }
        dirs.push(...dirMatches)
      } catch (e) {
        // Ignore glob errors for now
      }
    }

    return dirs
  }

  /**
   * 加载插件配置文件
   */
  private async loadManifests(dirs: string[]): Promise<PluginManifest[]> {
    const manifests: PluginManifest[] = []

    for (const dir of dirs) {
      try {
        const manifestPath = path.join(dir, 'plugin.json')
        const content = await fs.readFile(manifestPath, 'utf-8')
        const manifest = JSON.parse(content) as PluginManifest
        manifest.path = dir
        manifests.push(manifest)
      } catch (error) {
        this.logger.warn(`Failed to load manifest from ${dir}`, error as Error)
      }
    }

    return manifests
  }

  /**
   * 验证插件配置
   */
  private validateManifest(manifest: PluginManifest): boolean {
    // 使用增强的manifest validator进行全面验证
    const result = this.manifestValidator.validate(manifest as any)

    // 记录错误和警告
    if (result.errors.length > 0) {
      this.logger.error(`Manifest validation failed for ${manifest.name}:`)
      result.errors.forEach(error => {
        this.logger.error(`  - ${error}`)
      })
      return false
    }

    if (result.warnings.length > 0) {
      this.logger.warn(`Manifest validation warnings for ${manifest.name}:`)
      result.warnings.forEach(warning => {
        this.logger.warn(`  - ${warning}`)
      })
    }

    return true
  }

  /**
   * 拓扑排序（处理依赖关系）
   */
  private topologicalSort(manifests: PluginManifest[]): PluginManifest[] {
    const sorted: PluginManifest[] = []
    const visited = new Set<string>()
    const visiting = new Set<string>()

    const manifestMap = new Map<string, PluginManifest>()
    for (const manifest of manifests) {
      manifestMap.set(manifest.name, manifest)
    }

    const visit = (name: string) => {
      if (visited.has(name)) return
      if (visiting.has(name)) {
        throw new Error(`Circular dependency detected: ${name}`)
      }

      visiting.add(name)
      const manifest = manifestMap.get(name)

      if (manifest) {
        // 处理依赖
        const deps = [
          ...Object.keys(manifest.dependencies || {}),
          ...Object.keys(manifest.peerDependencies || {})
        ]

        for (const dep of deps) {
          if (manifestMap.has(dep)) {
            visit(dep)
          }
        }

        sorted.push(manifest)
      }

      visiting.delete(name)
      visited.add(name)
    }

    for (const manifest of manifests) {
      visit(manifest.name)
    }

    return sorted
  }

  /**
   * 加载单个插件
   */
  private async loadPlugin(manifest: PluginManifest): Promise<void> {
    this.logger.info(`Loading plugin: ${manifest.name}`)

    try {
      // 检查权限
      this.checkPermissions(manifest)

      // 创建插件上下文
      const context = createPluginContext(manifest, this.coreAPI)

      // 解析插件入口：支持纯 JS 源码 main，或 main.backend，或 dist/index.js
      let pluginPath: string
      if (typeof (manifest as any).main === 'string') {
        pluginPath = path.join((manifest as any).path || manifest.name, (manifest as any).main)
      } else if ((manifest as any).main?.backend) {
        pluginPath = path.join((manifest as any).path || manifest.name, (manifest as any).main.backend)
      } else {
        pluginPath = path.join((manifest as any).path || manifest.name, 'dist', 'index.js')
      }

      const pluginModule = await import(pluginPath)
      const PluginClass = pluginModule.default || pluginModule

      // 创建插件实例
      let plugin: PluginLifecycle
      if (typeof PluginClass === 'function') {
        plugin = new PluginClass()
      } else if (typeof pluginModule.onLoad === 'function' || typeof pluginModule.activate === 'function') {
        // 直接使用导出的生命周期对象
        plugin = pluginModule as any
      } else {
        plugin = PluginClass as any
      }

      // 创建插件实例记录
      const instance: PluginInstance = {
        manifest,
        plugin,
        context,
        status: 'loaded'
      }

      // 执行安装钩子
      if (plugin.install) {
        await plugin.install(context)
      } else if ((plugin as any).onLoad) {
        await (plugin as any).onLoad(context)
      }

      // 注册插件
      this.plugins.set(manifest.name, instance)
      this.loadOrder.push(manifest.name)

      this.logger.info(`Plugin ${manifest.name} loaded successfully`)
      this.emit('plugin:loaded', manifest.name)
    } catch (error) {
      this.logger.error(`Failed to load plugin ${manifest.name}`, error as Error)
      this.emit('plugin:error', { plugin: manifest.name, error })
      // Continue loading other plugins instead of failing completely
      this.logger.warn(`Skipping plugin ${manifest.name} and continuing...`)
    }
  }

  /**
   * 检查权限
   */
  private checkPermissions(manifest: PluginManifest): void {
    // TODO: 实现权限检查逻辑
    const requiredPermissions = manifest.permissions || []
    for (const permission of requiredPermissions) {
      this.logger.debug(`Checking permission: ${permission}`)
      // 验证权限是否合法
    }
  }

  /**
   * 激活所有插件
   */
  private async activatePlugins(): Promise<void> {
    for (const name of this.loadOrder) {
      const instance = this.plugins.get(name)
      if (instance && instance.status === 'loaded') {
        try {
          await instance.plugin.activate(instance.context)
          instance.status = 'active'
          this.logger.info(`Plugin ${name} activated`)
          this.emit('plugin:activated', name)
        } catch (error) {
          instance.status = 'error'
          this.logger.error(`Failed to activate plugin ${name}`, error as Error)
          this.emit('plugin:error', { plugin: name, error })
        }
      }
    }
  }

  /**
   * 停用插件
   */
  async deactivatePlugin(name: string): Promise<void> {
    const instance = this.plugins.get(name)
    if (!instance) {
      throw new Error(`Plugin ${name} not found`)
    }

    if (instance.status === 'active' && instance.plugin.deactivate) {
      await instance.plugin.deactivate()
      instance.status = 'inactive'
      this.logger.info(`Plugin ${name} deactivated`)
      this.emit('plugin:deactivated', name)
    }
  }

  /**
   * 卸载插件
   */
  async unloadPlugin(name: string): Promise<void> {
    const instance = this.plugins.get(name)
    if (!instance) {
      throw new Error(`Plugin ${name} not found`)
    }

    // 先停用
    await this.deactivatePlugin(name)

    // 执行卸载钩子
    if (instance.plugin.uninstall) {
      await instance.plugin.uninstall()
    }

    // 移除插件
    this.plugins.delete(name)
    const index = this.loadOrder.indexOf(name)
    if (index > -1) {
      this.loadOrder.splice(index, 1)
    }

    // 事件 / 消息 订阅清理（按插件名）
    try {
      // Lazy import to avoid circular issues
      const { eventBus } = await import('../integration/events/event-bus')
      const { messageBus } = await import('../integration/messaging/message-bus')
      const evRemoved = eventBus.unsubscribeByPlugin(name)
      const msgRemoved = messageBus.unsubscribeByPlugin(name)
      this.logger.info(`Cleaned subscriptions for ${name}`, { events: evRemoved, messages: msgRemoved })
    } catch (e) {
      this.logger.warn(`Subscription cleanup failed for ${name}`, e as Error)
    }

    this.logger.info(`Plugin ${name} unloaded`)
    this.emit('plugin:unloaded', name)
  }

  /**
   * 获取所有插件
   */
  getPlugins(): Map<string, PluginInstance> {
    return new Map(this.plugins)
  }

  /**
   * 获取单个插件
   */
  getPlugin(name: string): PluginInstance | undefined {
    return this.plugins.get(name)
  }

  /**
   * 重新加载插件
   */
  async reloadPlugin(name: string): Promise<void> {
    const instance = this.plugins.get(name)
    if (!instance) {
      throw new Error(`Plugin ${name} not found for reload`)
    }

    // 保存插件路径信息用于重新加载
    const pluginPath = (instance.manifest as any).path
    if (!pluginPath) {
      throw new Error(`Plugin ${name} has no path information for reload`)
    }

    this.logger.info(`Reloading plugin: ${name}`)
    this.emit('plugin:reloading', name)

    // 卸载插件
    await this.unloadPlugin(name)

    // 重新加载 manifest
    const manifestPath = path.join(pluginPath, 'plugin.json')
    let manifest: PluginManifest

    try {
      const content = await fs.readFile(manifestPath, 'utf-8')
      manifest = JSON.parse(content) as PluginManifest
      manifest.path = pluginPath
    } catch (error) {
      this.logger.error(`Failed to reload manifest for ${name}`, error as Error)
      this.emit('plugin:reload:failed', { name, error })
      throw new Error(`Failed to reload manifest for ${name}: ${(error as Error).message}`)
    }

    // 验证 manifest
    if (!this.validateManifest(manifest)) {
      this.emit('plugin:reload:failed', { name, error: 'Manifest validation failed' })
      throw new Error(`Manifest validation failed for ${name}`)
    }

    // 重新加载插件
    try {
      await this.loadPlugin(manifest)
      this.logger.info(`Plugin ${name} reloaded successfully`)
      this.emit('plugin:reloaded', name)
    } catch (error) {
      this.logger.error(`Failed to reload plugin ${name}`, error as Error)
      this.emit('plugin:reload:failed', { name, error })
      throw error
    }
  }
}

