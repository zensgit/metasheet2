/**
 * 插件注册中心
 * 提供插件的集中管理、生命周期控制、依赖管理等功能
 */

import { EventEmitter } from 'eventemitter3'
import semver from 'semver'
import {
  PluginManifest,
  PluginInstance,
  PluginRegistration,
  PluginCapability,
  PluginStatus,
  PluginEventType,
  PluginDependency,
  CoreAPI
} from '../types/plugin'
import { CAPABILITY_PERMISSIONS } from '../types/plugin'
import { PluginLoader } from './plugin-loader'
import { Logger } from './logger'

/**
 * 插件依赖解析器
 */
class DependencyResolver {
  private logger: Logger

  constructor() {
    this.logger = new Logger('DependencyResolver')
  }

  /**
   * 解析插件依赖关系
   */
  resolveDependencies(
    plugins: PluginManifest[],
    targetPlugin?: string
  ): { order: string[]; conflicts: string[]; missing: string[] } {
    const pluginMap = new Map<string, PluginManifest>()
    const order: string[] = []
    const visited = new Set<string>()
    const visiting = new Set<string>()
    const conflicts: string[] = []
    const missing: string[] = []

    // 构建插件映射
    for (const plugin of plugins) {
      pluginMap.set(plugin.name, plugin)
    }

    // 深度优先搜索
    const visit = (pluginName: string): boolean => {
      if (visited.has(pluginName)) {
        return true
      }

      if (visiting.has(pluginName)) {
        conflicts.push(`Circular dependency detected: ${pluginName}`)
        return false
      }

      const plugin = pluginMap.get(pluginName)
      if (!plugin) {
        missing.push(pluginName)
        return false
      }

      visiting.add(pluginName)

      // 处理依赖
      const dependencies = [
        ...Object.keys(plugin.dependencies || {}),
        ...Object.keys(plugin.peerDependencies || {})
      ]

      for (const depName of dependencies) {
        if (!visit(depName)) {
          return false
        }

        // 版本兼容性检查
        const depPlugin = pluginMap.get(depName)
        if (depPlugin) {
          const requiredVersion = plugin.dependencies?.[depName] || plugin.peerDependencies?.[depName]
          if (requiredVersion && !semver.satisfies(depPlugin.version, requiredVersion)) {
            conflicts.push(
              `Version conflict: ${pluginName} requires ${depName}@${requiredVersion}, ` +
              `but found ${depPlugin.version}`
            )
          }
        }
      }

      visiting.delete(pluginName)
      visited.add(pluginName)
      order.push(pluginName)

      return true
    }

    // 如果指定了目标插件，只解析该插件的依赖
    if (targetPlugin) {
      visit(targetPlugin)
    } else {
      // 解析所有插件
      for (const plugin of plugins) {
        visit(plugin.name)
      }
    }

    return { order, conflicts, missing }
  }

  /**
   * 检查插件能力依赖
   */
  checkCapabilityDependencies(
    plugin: PluginManifest,
    availableCapabilities: Map<string, PluginCapability[]>
  ): string[] {
    const missing: string[] = []

    if (plugin.contributes) {
      // 检查视图依赖
      if (plugin.contributes.views) {
        for (const view of plugin.contributes.views) {
          if (view.depends && view.depends.length > 0) {
            for (const capability of view.depends) {
              if (!this.hasCapability(capability, availableCapabilities)) {
                missing.push(`View capability dependency missing: ${capability}`)
              }
            }
          }
        }
      }

      // 检查工作流依赖
      if (plugin.contributes.actions) {
        for (const action of plugin.contributes.actions) {
          if (action.depends && action.depends.length > 0) {
            for (const capability of action.depends) {
              if (!this.hasCapability(capability, availableCapabilities)) {
                missing.push(`Action capability dependency missing: ${capability}`)
              }
            }
          }
        }
      }
    }

    return missing
  }

  private hasCapability(
    capability: PluginCapability,
    availableCapabilities: Map<string, PluginCapability[]>
  ): boolean {
    for (const [, capabilities] of availableCapabilities) {
      if (capabilities.includes(capability)) {
        return true
      }
    }
    return false
  }
}

/**
 * 插件注册中心实现
 */
export class PluginRegistry extends EventEmitter {
  private registrations = new Map<string, PluginRegistration>()
  private loader: PluginLoader
  private dependencyResolver: DependencyResolver
  private logger: Logger
  private capabilities = new Map<string, PluginCapability[]>()

  constructor(coreAPI: CoreAPI) {
    super()
    this.loader = new PluginLoader(coreAPI)
    this.dependencyResolver = new DependencyResolver()
    this.logger = new Logger('PluginRegistry')

    // 监听插件加载器事件
    this.setupLoaderListeners()
  }

  private setupLoaderListeners(): void {
    this.loader.on('plugin:loaded', (pluginName: string) => {
      this.updatePluginStatus(pluginName, PluginStatus.ENABLED)
      this.emit(PluginEventType.ENABLED, pluginName)
    })

    this.loader.on('plugin:activated', (pluginName: string) => {
      this.updatePluginStatus(pluginName, PluginStatus.ENABLED)
      const registration = this.registrations.get(pluginName)
      if (registration) {
        registration.lastActivated = new Date()
      }
    })

    this.loader.on('plugin:error', ({ plugin, error }: { plugin: string; error: any }) => {
      this.updatePluginStatus(plugin, PluginStatus.ERROR, (error as Error).message)
      this.emit(PluginEventType.ERROR, { plugin, error })
    })
  }

  /**
   * 注册插件
   */
  async registerPlugin(manifest: PluginManifest): Promise<PluginRegistration> {
    try {
      this.logger.info(`Registering plugin: ${manifest.name}`)

      // 验证插件清单
      this.validateManifest(manifest)

      // 检查插件是否已注册
      if (this.registrations.has(manifest.name)) {
        throw new Error(`Plugin ${manifest.name} is already registered`)
      }

      // 解析插件能力
      const capabilities = this.extractCapabilities(manifest)

      // 检查权限兼容性
      this.validatePermissions(manifest, capabilities)

      // 创建注册信息
      const registration: PluginRegistration = {
        manifest,
        capabilities,
        dependencies: this.extractDependencies(manifest),
        status: PluginStatus.INSTALLED,
        installedAt: new Date()
      }

      // 保存注册信息
      this.registrations.set(manifest.name, registration)
      this.capabilities.set(manifest.name, capabilities)

      this.logger.info(`Plugin registered successfully: ${manifest.name}`)
      this.emit(PluginEventType.INSTALLED, manifest.name)

      return registration
    } catch (error) {
      this.logger.error(`Failed to register plugin ${manifest.name}`, error as Error)
      throw error
    }
  }

  /**
   * 启用插件
   */
  async enablePlugin(pluginName: string): Promise<void> {
    const registration = this.registrations.get(pluginName)
    if (!registration) {
      throw new Error(`Plugin ${pluginName} is not registered`)
    }

    if (registration.status === PluginStatus.ENABLED) {
      this.logger.warn(`Plugin ${pluginName} is already enabled`)
      return
    }

    try {
      // 检查依赖关系
      await this.checkDependencies(pluginName)

      // 更新状态
      this.updatePluginStatus(pluginName, PluginStatus.LOADING)

      // 通过加载器启用插件（使用公开API，而非调用私有方法）
      // 此处简单复用 Loader 的单个加载流程
      await (this.loader as any).loadPlugin(registration.manifest)

      this.logger.info(`Plugin enabled: ${pluginName}`)
    } catch (error) {
      this.updatePluginStatus(pluginName, PluginStatus.ERROR, (error as Error).message)
      this.logger.error(`Failed to enable plugin ${pluginName}`, error as Error)
      throw error
    }
  }

  /**
   * 禁用插件
   */
  async disablePlugin(pluginName: string): Promise<void> {
    const registration = this.registrations.get(pluginName)
    if (!registration) {
      throw new Error(`Plugin ${pluginName} is not registered`)
    }

    if (registration.status === PluginStatus.DISABLED) {
      this.logger.warn(`Plugin ${pluginName} is already disabled`)
      return
    }

    try {
      // 检查是否有其他插件依赖此插件
      this.checkReverseDependencies(pluginName)

      // 通过加载器停用插件
      await this.loader.deactivatePlugin(pluginName)

      // 更新状态
      this.updatePluginStatus(pluginName, PluginStatus.DISABLED)

      this.logger.info(`Plugin disabled: ${pluginName}`)
      this.emit(PluginEventType.DISABLED, pluginName)
    } catch (error) {
      this.logger.error(`Failed to disable plugin ${pluginName}`, error as Error)
      throw error
    }
  }

  /**
   * 卸载插件
   */
  async uninstallPlugin(pluginName: string): Promise<void> {
    const registration = this.registrations.get(pluginName)
    if (!registration) {
      throw new Error(`Plugin ${pluginName} is not registered`)
    }

    try {
      // 先禁用插件
      if (registration.status === PluginStatus.ENABLED) {
        await this.disablePlugin(pluginName)
      }

      // 通过加载器卸载插件
      await this.loader.unloadPlugin(pluginName)

      // 移除注册信息
      this.registrations.delete(pluginName)
      this.capabilities.delete(pluginName)

      this.logger.info(`Plugin uninstalled: ${pluginName}`)
      this.emit(PluginEventType.UNINSTALLED, pluginName)
    } catch (error) {
      this.logger.error(`Failed to uninstall plugin ${pluginName}`, error as Error)
      throw error
    }
  }

  /**
   * 更新插件
   */
  async updatePlugin(pluginName: string, newManifest: PluginManifest): Promise<void> {
    const registration = this.registrations.get(pluginName)
    if (!registration) {
      throw new Error(`Plugin ${pluginName} is not registered`)
    }

    try {
      const wasEnabled = registration.status === PluginStatus.ENABLED

      // 更新状态
      this.updatePluginStatus(pluginName, PluginStatus.UPDATING)

      // 如果插件已启用，先禁用
      if (wasEnabled) {
        await this.disablePlugin(pluginName)
      }

      // 验证新清单
      this.validateManifest(newManifest)

      // 检查版本
      if (!semver.gt(newManifest.version, registration.manifest.version)) {
        throw new Error(
          `New version ${newManifest.version} is not greater than current version ${registration.manifest.version}`
        )
      }

      // 更新注册信息
      registration.manifest = newManifest
      registration.capabilities = this.extractCapabilities(newManifest)
      registration.dependencies = this.extractDependencies(newManifest)

      // 如果原本启用，重新启用
      if (wasEnabled) {
        await this.enablePlugin(pluginName)
      } else {
        this.updatePluginStatus(pluginName, PluginStatus.INSTALLED)
      }

      this.logger.info(`Plugin updated: ${pluginName} to version ${newManifest.version}`)
    } catch (error) {
      this.updatePluginStatus(pluginName, PluginStatus.ERROR, (error as Error).message)
      this.logger.error(`Failed to update plugin ${pluginName}`, error as Error)
      throw error
    }
  }

  /**
   * 获取插件注册信息
   */
  getPlugin(pluginName: string): PluginRegistration | null {
    return this.registrations.get(pluginName) || null
  }

  /**
   * 获取所有插件
   */
  getAllPlugins(): PluginRegistration[] {
    return Array.from(this.registrations.values())
  }

  /**
   * 按状态获取插件
   */
  getPluginsByStatus(status: PluginStatus): PluginRegistration[] {
    return Array.from(this.registrations.values()).filter(p => p.status === status)
  }

  /**
   * 按能力获取插件
   */
  getPluginsByCapability(capability: PluginCapability): PluginRegistration[] {
    return Array.from(this.registrations.values()).filter(p =>
      p.capabilities?.includes(capability)
    )
  }

  /**
   * 检查插件依赖
   */
  private async checkDependencies(pluginName: string): Promise<void> {
    const allManifests = Array.from(this.registrations.values()).map(r => r.manifest)
    const { conflicts, missing } = this.dependencyResolver.resolveDependencies(
      allManifests,
      pluginName
    )

    if (conflicts.length > 0) {
      throw new Error(`Dependency conflicts: ${conflicts.join('; ')}`)
    }

    if (missing.length > 0) {
      throw new Error(`Missing dependencies: ${missing.join(', ')}`)
    }

    // 检查能力依赖
    const registration = this.registrations.get(pluginName)!
    const missingCapabilities = this.dependencyResolver.checkCapabilityDependencies(
      registration.manifest,
      this.capabilities
    )

    if (missingCapabilities.length > 0) {
      throw new Error(`Missing capabilities: ${missingCapabilities.join(', ')}`)
    }
  }

  /**
   * 检查反向依赖
   */
  private checkReverseDependencies(pluginName: string): void {
    const dependents: string[] = []

    for (const [name, registration] of this.registrations) {
      if (name === pluginName || registration.status !== PluginStatus.ENABLED) {
        continue
      }

      const dependencies = [
        ...Object.keys(registration.manifest.dependencies || {}),
        ...Object.keys(registration.manifest.peerDependencies || {})
      ]

      if (dependencies.includes(pluginName)) {
        dependents.push(name)
      }
    }

    if (dependents.length > 0) {
      throw new Error(
        `Cannot disable plugin ${pluginName}: it is required by ${dependents.join(', ')}`
      )
    }
  }

  /**
   * 验证插件清单
   */
  private validateManifest(manifest: PluginManifest): void {
    if (!manifest.name || !manifest.version) {
      throw new Error('Plugin manifest must include name and version')
    }

    if (!semver.valid(manifest.version)) {
      throw new Error(`Invalid version format: ${manifest.version}`)
    }

    if (!manifest.engines?.metasheet) {
      throw new Error('Plugin manifest must specify metasheet engine version')
    }
  }

  /**
   * 提取插件能力
   */
  private extractCapabilities(manifest: PluginManifest): PluginCapability[] {
    const capabilities: PluginCapability[] = []

    if (manifest.contributes) {
      const { contributes } = manifest

      if (contributes.views && contributes.views.length > 0) {
        capabilities.push(PluginCapability.VIEW_PROVIDER)
      }

      if (contributes.fieldTypes && contributes.fieldTypes.length > 0) {
        capabilities.push(PluginCapability.FIELD_TYPE)
      }

      if (contributes.formulas && contributes.formulas.length > 0) {
        capabilities.push(PluginCapability.FORMULA_FUNCTION)
      }

      if (contributes.triggers && contributes.triggers.length > 0) {
        capabilities.push(PluginCapability.TRIGGER_PROVIDER)
      }

      if (contributes.actions && contributes.actions.length > 0) {
        capabilities.push(PluginCapability.ACTION_PROVIDER)
      }

      if (contributes.commands && contributes.commands.length > 0) {
        capabilities.push(PluginCapability.API_ENDPOINT)
      }

      if (contributes.menus) {
        capabilities.push(PluginCapability.MENU_ITEM)
      }
    }

    return capabilities
  }

  /**
   * 提取插件依赖
   */
  private extractDependencies(manifest: PluginManifest): PluginDependency[] {
    const dependencies: PluginDependency[] = []

    // 处理普通依赖
    if (manifest.dependencies) {
      for (const [name, version] of Object.entries(manifest.dependencies)) {
        dependencies.push({ name, version, optional: false })
      }
    }

    // 处理对等依赖
    if (manifest.peerDependencies) {
      for (const [name, version] of Object.entries(manifest.peerDependencies)) {
        dependencies.push({ name, version, optional: true })
      }
    }

    return dependencies
  }

  /**
   * 验证权限
   */
  private validatePermissions(manifest: PluginManifest, capabilities: PluginCapability[]): void {
    const requiredPermissions = new Set<string>()

    // 根据能力计算所需权限
    for (const capability of capabilities) {
      const permissions = CAPABILITY_PERMISSIONS[capability] || []
      permissions.forEach(p => requiredPermissions.add(p))
    }

    // 检查清单中的权限是否包含所需权限
    // Handle both old array format and new V2 object format
    const perms = manifest.permissions
    const manifestPermissions = new Set(Array.isArray(perms) ? perms : [])

    for (const required of requiredPermissions) {
      if (!manifestPermissions.has(required) && !manifestPermissions.has('*')) {
        this.logger.warn(
          `Plugin ${manifest.name} capability ${capabilities} requires permission ${required} ` +
          `but it's not declared in manifest`
        )
      }
    }
  }

  /**
   * 更新插件状态
   */
  private updatePluginStatus(pluginName: string, status: PluginStatus, error?: string): void {
    const registration = this.registrations.get(pluginName)
    if (registration) {
      registration.status = status
      if (error) {
        registration.error = error
      } else {
        delete registration.error
      }
    }
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    total: number
    enabled: number
    disabled: number
    error: number
    capabilities: Record<PluginCapability, number>
  } {
    const stats = {
      total: this.registrations.size,
      enabled: 0,
      disabled: 0,
      error: 0,
      capabilities: {} as Record<PluginCapability, number>
    }

    // 初始化能力计数
    for (const capability of Object.values(PluginCapability)) {
      stats.capabilities[capability] = 0
    }

    // 统计状态和能力
    for (const registration of this.registrations.values()) {
      switch (registration.status) {
        case PluginStatus.ENABLED:
          stats.enabled++
          break
        case PluginStatus.DISABLED:
          stats.disabled++
          break
        case PluginStatus.ERROR:
          stats.error++
          break
      }

      // 统计能力
      for (const capability of registration.capabilities || []) {
        stats.capabilities[capability]++
      }
    }

    return stats
  }

  /**
   * 获取依赖图
   */
  getDependencyGraph(): Record<string, string[]> {
    const graph: Record<string, string[]> = {}

    for (const [name, registration] of this.registrations) {
      graph[name] = (registration.dependencies || []).map(dep => dep.name)
    }

    return graph
  }
}
