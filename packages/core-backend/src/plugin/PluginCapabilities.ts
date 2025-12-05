/**
 * 插件能力系统
 * 定义和管理插件的各种能力，提供能力验证和权限检查
 */

import { EventEmitter } from 'eventemitter3'
// Use value imports for runtime enums/constants; Phase A tolerates any typing looseness
import type { PluginManifest } from '../types/plugin'
import { PluginCapability, CAPABILITY_PERMISSIONS } from '../types/plugin'
import { Logger } from '../core/logger'

/**
 * 能力依赖关系定义
 */
export const CAPABILITY_DEPENDENCIES: Record<PluginCapability, PluginCapability[]> = {
  [PluginCapability.VIEW_PROVIDER]: [PluginCapability.CUSTOM_COMPONENT],
  [PluginCapability.CUSTOM_COMPONENT]: [],
  [PluginCapability.WORKFLOW_NODE]: [PluginCapability.DATA_SOURCE],
  [PluginCapability.TRIGGER_PROVIDER]: [],
  [PluginCapability.ACTION_PROVIDER]: [PluginCapability.NOTIFICATION_CHANNEL],
  [PluginCapability.DATA_SOURCE]: [],
  [PluginCapability.FORMULA_FUNCTION]: [],
  [PluginCapability.FIELD_TYPE]: [],
  [PluginCapability.API_ENDPOINT]: [],
  [PluginCapability.WEBHOOK_HANDLER]: [PluginCapability.API_ENDPOINT],
  [PluginCapability.EXTERNAL_AUTH]: [PluginCapability.AUTH_PROVIDER],
  [PluginCapability.NOTIFICATION_CHANNEL]: [],
  [PluginCapability.EMAIL_TEMPLATE]: [PluginCapability.NOTIFICATION_CHANNEL],
  [PluginCapability.AUTH_PROVIDER]: [],
  [PluginCapability.PERMISSION_PROVIDER]: [PluginCapability.AUTH_PROVIDER],
  [PluginCapability.BACKGROUND_TASK]: [PluginCapability.SCHEDULED_JOB],
  [PluginCapability.SCHEDULED_JOB]: [],
  [PluginCapability.CACHE_PROVIDER]: [],
  [PluginCapability.MENU_ITEM]: [PluginCapability.CUSTOM_COMPONENT],
  [PluginCapability.TOOLBAR_BUTTON]: [PluginCapability.CUSTOM_COMPONENT],
  [PluginCapability.CONTEXT_MENU]: [PluginCapability.CUSTOM_COMPONENT],
  [PluginCapability.SETTINGS_PAGE]: [PluginCapability.CUSTOM_COMPONENT],
  // Core capabilities
  [PluginCapability.DATABASE]: [],
  [PluginCapability.HTTP]: [],
  [PluginCapability.WEBSOCKET]: [],
  [PluginCapability.STORAGE]: [],
  [PluginCapability.SCHEDULER]: [],
  [PluginCapability.NOTIFICATION]: []
}

/**
 * 能力冲突定义（互斥的能力）
 */
export const CAPABILITY_CONFLICTS: Record<PluginCapability, PluginCapability[]> = {
  [PluginCapability.VIEW_PROVIDER]: [],
  [PluginCapability.CUSTOM_COMPONENT]: [],
  [PluginCapability.WORKFLOW_NODE]: [],
  [PluginCapability.TRIGGER_PROVIDER]: [],
  [PluginCapability.ACTION_PROVIDER]: [],
  [PluginCapability.DATA_SOURCE]: [],
  [PluginCapability.FORMULA_FUNCTION]: [],
  [PluginCapability.FIELD_TYPE]: [],
  [PluginCapability.API_ENDPOINT]: [],
  [PluginCapability.WEBHOOK_HANDLER]: [],
  [PluginCapability.EXTERNAL_AUTH]: [PluginCapability.AUTH_PROVIDER], // 外部认证与内置认证冲突
  [PluginCapability.NOTIFICATION_CHANNEL]: [],
  [PluginCapability.EMAIL_TEMPLATE]: [],
  [PluginCapability.AUTH_PROVIDER]: [PluginCapability.EXTERNAL_AUTH], // 内置认证与外部认证冲突
  [PluginCapability.PERMISSION_PROVIDER]: [],
  [PluginCapability.BACKGROUND_TASK]: [],
  [PluginCapability.SCHEDULED_JOB]: [],
  [PluginCapability.CACHE_PROVIDER]: [],
  [PluginCapability.MENU_ITEM]: [],
  [PluginCapability.TOOLBAR_BUTTON]: [],
  [PluginCapability.CONTEXT_MENU]: [],
  [PluginCapability.SETTINGS_PAGE]: [],
  // Core capabilities
  [PluginCapability.DATABASE]: [],
  [PluginCapability.HTTP]: [],
  [PluginCapability.WEBSOCKET]: [],
  [PluginCapability.STORAGE]: [],
  [PluginCapability.SCHEDULER]: [],
  [PluginCapability.NOTIFICATION]: []
}

/**
 * 能力优先级定义（用于解决冲突时的选择）
 */
export const CAPABILITY_PRIORITY: Record<PluginCapability, number> = {
  [PluginCapability.AUTH_PROVIDER]: 10,
  [PluginCapability.PERMISSION_PROVIDER]: 9,
  [PluginCapability.DATA_SOURCE]: 8,
  [PluginCapability.CACHE_PROVIDER]: 7,
  [PluginCapability.NOTIFICATION_CHANNEL]: 6,
  [PluginCapability.API_ENDPOINT]: 5,
  [PluginCapability.VIEW_PROVIDER]: 4,
  [PluginCapability.WORKFLOW_NODE]: 3,
  [PluginCapability.TRIGGER_PROVIDER]: 3,
  [PluginCapability.ACTION_PROVIDER]: 3,
  [PluginCapability.EXTERNAL_AUTH]: 2,
  [PluginCapability.WEBHOOK_HANDLER]: 2,
  [PluginCapability.SCHEDULED_JOB]: 2,
  [PluginCapability.BACKGROUND_TASK]: 2,
  [PluginCapability.FORMULA_FUNCTION]: 1,
  [PluginCapability.FIELD_TYPE]: 1,
  [PluginCapability.EMAIL_TEMPLATE]: 1,
  [PluginCapability.CUSTOM_COMPONENT]: 1,
  [PluginCapability.MENU_ITEM]: 0,
  [PluginCapability.TOOLBAR_BUTTON]: 0,
  [PluginCapability.CONTEXT_MENU]: 0,
  [PluginCapability.SETTINGS_PAGE]: 0,
  // Core capabilities
  [PluginCapability.DATABASE]: 5,
  [PluginCapability.HTTP]: 5,
  [PluginCapability.WEBSOCKET]: 4,
  [PluginCapability.STORAGE]: 4,
  [PluginCapability.SCHEDULER]: 3,
  [PluginCapability.NOTIFICATION]: 3
}

/**
 * 能力描述
 */
export const CAPABILITY_DESCRIPTIONS: Record<PluginCapability, string> = {
  [PluginCapability.VIEW_PROVIDER]: '提供自定义视图（如看板、甘特图等）',
  [PluginCapability.CUSTOM_COMPONENT]: '提供自定义UI组件',
  [PluginCapability.WORKFLOW_NODE]: '提供工作流节点',
  [PluginCapability.TRIGGER_PROVIDER]: '提供触发器',
  [PluginCapability.ACTION_PROVIDER]: '提供动作执行器',
  [PluginCapability.DATA_SOURCE]: '提供数据源连接',
  [PluginCapability.FORMULA_FUNCTION]: '提供自定义公式函数',
  [PluginCapability.FIELD_TYPE]: '提供自定义字段类型',
  [PluginCapability.API_ENDPOINT]: '提供API端点',
  [PluginCapability.WEBHOOK_HANDLER]: '处理Webhook请求',
  [PluginCapability.EXTERNAL_AUTH]: '提供外部认证集成',
  [PluginCapability.NOTIFICATION_CHANNEL]: '提供通知渠道',
  [PluginCapability.EMAIL_TEMPLATE]: '提供邮件模板',
  [PluginCapability.AUTH_PROVIDER]: '提供认证服务',
  [PluginCapability.PERMISSION_PROVIDER]: '提供权限控制',
  [PluginCapability.BACKGROUND_TASK]: '提供后台任务',
  [PluginCapability.SCHEDULED_JOB]: '提供定时任务',
  [PluginCapability.CACHE_PROVIDER]: '提供缓存服务',
  [PluginCapability.MENU_ITEM]: '提供菜单项',
  [PluginCapability.TOOLBAR_BUTTON]: '提供工具栏按钮',
  [PluginCapability.CONTEXT_MENU]: '提供上下文菜单',
  [PluginCapability.SETTINGS_PAGE]: '提供设置页面',
  // Core capabilities
  [PluginCapability.DATABASE]: '提供数据库访问能力',
  [PluginCapability.HTTP]: '提供HTTP请求能力',
  [PluginCapability.WEBSOCKET]: '提供WebSocket能力',
  [PluginCapability.STORAGE]: '提供文件存储能力',
  [PluginCapability.SCHEDULER]: '提供任务调度能力',
  [PluginCapability.NOTIFICATION]: '提供通知能力'
}

/**
 * 能力验证结果
 */
export interface CapabilityValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
  missingDependencies: PluginCapability[]
  conflicts: PluginCapability[]
  requiredPermissions: string[]
}

/**
 * 能力注册信息
 */
export interface CapabilityRegistration {
  pluginName: string
  capability: PluginCapability
  implementation: unknown
  priority: number
  metadata: Record<string, unknown>
  registeredAt: Date
}

/**
 * 插件能力管理器
 */
export class PluginCapabilityManager extends EventEmitter {
  private registrations = new Map<PluginCapability, CapabilityRegistration[]>()
  private pluginCapabilities = new Map<string, Set<PluginCapability>>()
  private logger: Logger

  constructor() {
    super()
    this.logger = new Logger('PluginCapabilityManager')
  }

  /**
   * 验证插件能力
   */
  validateCapabilities(manifest: PluginManifest, requestedCapabilities: PluginCapability[]): CapabilityValidationResult {
    const result: CapabilityValidationResult = {
      valid: true,
      errors: [],
      warnings: [],
      missingDependencies: [],
      conflicts: [],
      requiredPermissions: []
    }

    // 检查能力依赖
    const allRequiredCapabilities = this.resolveDependencies(requestedCapabilities)
    const missingCapabilities = allRequiredCapabilities.filter(cap => !requestedCapabilities.includes(cap))

    if (missingCapabilities.length > 0) {
      result.missingDependencies = missingCapabilities
      result.errors.push(`Missing required capabilities: ${missingCapabilities.join(', ')}`)
      result.valid = false
    }

    // 检查能力冲突
    const conflicts = this.findConflicts(requestedCapabilities)
    if (conflicts.length > 0) {
      result.conflicts = conflicts
      result.errors.push(`Conflicting capabilities detected: ${conflicts.join(', ')}`)
      result.valid = false
    }

    // 收集所需权限
    const requiredPermissions = this.getRequiredPermissions(requestedCapabilities)
    result.requiredPermissions = Array.from(new Set(requiredPermissions))

    // 检查权限是否在插件清单中声明
    // Handle both old array format and new V2 object format
    const perms = manifest.permissions
    const declaredPermissions = new Set(Array.isArray(perms) ? perms : [])
    const missingPermissions = requiredPermissions.filter(perm =>
      !declaredPermissions.has(perm) && !declaredPermissions.has('*')
    )

    if (missingPermissions.length > 0) {
      result.errors.push(`Missing required permissions: ${missingPermissions.join(', ')}`)
      result.valid = false
    }

    // 检查能力的实现要求
    for (const capability of requestedCapabilities) {
      const implementationCheck = this.validateCapabilityImplementation(manifest, capability)
      if (!implementationCheck.valid) {
        result.errors.push(...implementationCheck.errors)
        result.warnings.push(...implementationCheck.warnings)
        result.valid = false
      }
    }

    return result
  }

  /**
   * 注册能力实现
   */
  registerCapability(
    pluginName: string,
    capability: PluginCapability,
    implementation: unknown,
    metadata: Record<string, unknown> = {}
  ): void {
    const registration: CapabilityRegistration = {
      pluginName,
      capability,
      implementation,
      priority: CAPABILITY_PRIORITY[capability],
      metadata,
      registeredAt: new Date()
    }

    if (!this.registrations.has(capability)) {
      this.registrations.set(capability, [])
    }

    const existing = this.registrations.get(capability)!
    existing.push(registration)
    existing.sort((a, b) => b.priority - a.priority) // 按优先级排序

    // 更新插件能力映射
    if (!this.pluginCapabilities.has(pluginName)) {
      this.pluginCapabilities.set(pluginName, new Set())
    }
    this.pluginCapabilities.get(pluginName)!.add(capability)

    this.emit('capability:registered', { pluginName, capability, registration })
    this.logger.info(`Registered capability ${capability} for plugin ${pluginName}`)
  }

  /**
   * 取消注册能力
   */
  unregisterCapability(pluginName: string, capability: PluginCapability): void {
    const registrations = this.registrations.get(capability)
    if (registrations) {
      const index = registrations.findIndex(reg => reg.pluginName === pluginName)
      if (index !== -1) {
        registrations.splice(index, 1)
        if (registrations.length === 0) {
          this.registrations.delete(capability)
        }
      }
    }

    // 更新插件能力映射
    const pluginCaps = this.pluginCapabilities.get(pluginName)
    if (pluginCaps) {
      pluginCaps.delete(capability)
      if (pluginCaps.size === 0) {
        this.pluginCapabilities.delete(pluginName)
      }
    }

    this.emit('capability:unregistered', { pluginName, capability })
    this.logger.info(`Unregistered capability ${capability} for plugin ${pluginName}`)
  }

  /**
   * 取消注册插件的所有能力
   */
  unregisterPluginCapabilities(pluginName: string): void {
    const capabilities = this.pluginCapabilities.get(pluginName)
    if (capabilities) {
      for (const capability of capabilities) {
        this.unregisterCapability(pluginName, capability)
      }
    }
  }

  /**
   * 获取能力的实现
   */
  getCapabilityImplementations(capability: PluginCapability): CapabilityRegistration[] {
    return this.registrations.get(capability) || []
  }

  /**
   * 获取最高优先级的能力实现
   */
  getPrimaryImplementation(capability: PluginCapability): CapabilityRegistration | null {
    const implementations = this.getCapabilityImplementations(capability)
    return implementations.length > 0 ? implementations[0] : null
  }

  /**
   * 获取插件的能力
   */
  getPluginCapabilities(pluginName: string): PluginCapability[] {
    const capabilities = this.pluginCapabilities.get(pluginName)
    return capabilities ? Array.from(capabilities) : []
  }

  /**
   * 检查插件是否具有某个能力
   */
  hasCapability(pluginName: string, capability: PluginCapability): boolean {
    const capabilities = this.pluginCapabilities.get(pluginName)
    return capabilities ? capabilities.has(capability) : false
  }

  /**
   * 获取所有已注册的能力
   */
  getAllRegisteredCapabilities(): PluginCapability[] {
    return Array.from(this.registrations.keys())
  }

  /**
   * 获取能力统计信息
   */
  getCapabilityStats(): Record<PluginCapability, number> {
    const stats: Record<string, number> = {}
    for (const [capability, registrations] of this.registrations.entries()) {
      stats[capability] = registrations.length
    }
    return stats as Record<PluginCapability, number>
  }

  /**
   * 解析能力依赖
   */
  private resolveDependencies(capabilities: PluginCapability[]): PluginCapability[] {
    const resolved = new Set<PluginCapability>(capabilities)
    const toProcess = [...capabilities]

    while (toProcess.length > 0) {
      const current = toProcess.shift()!
      const dependencies = CAPABILITY_DEPENDENCIES[current] || []

      for (const dep of dependencies) {
        if (!resolved.has(dep)) {
          resolved.add(dep)
          toProcess.push(dep)
        }
      }
    }

    return Array.from(resolved)
  }

  /**
   * 查找能力冲突
   */
  private findConflicts(capabilities: PluginCapability[]): PluginCapability[] {
    const conflicts: PluginCapability[] = []

    for (let i = 0; i < capabilities.length; i++) {
      const capability = capabilities[i]
      const conflictsWith = CAPABILITY_CONFLICTS[capability] || []

      for (const conflict of conflictsWith) {
        if (capabilities.includes(conflict) && !conflicts.includes(conflict)) {
          conflicts.push(conflict)
        }
      }
    }

    return conflicts
  }

  /**
   * 获取能力所需的权限
   */
  private getRequiredPermissions(capabilities: PluginCapability[]): string[] {
    const permissions: string[] = []

    for (const capability of capabilities) {
      const capabilityPermissions = CAPABILITY_PERMISSIONS[capability] || []
      permissions.push(...capabilityPermissions)
    }

    return permissions
  }

  /**
   * 验证能力的实现要求
   */
  private validateCapabilityImplementation(
    manifest: PluginManifest,
    capability: PluginCapability
  ): { valid: boolean; errors: string[]; warnings: string[] } {
    const result: { valid: boolean; errors: string[]; warnings: string[] } = { valid: true, errors: [], warnings: [] }

    switch (capability) {
      case PluginCapability.VIEW_PROVIDER:
        if (!manifest.contributes?.views || manifest.contributes.views.length === 0) {
          result.errors.push('VIEW_PROVIDER capability requires views contribution in manifest')
          result.valid = false
        }
        break

      case PluginCapability.FORMULA_FUNCTION:
        if (!manifest.contributes?.formulas || manifest.contributes.formulas.length === 0) {
          result.errors.push('FORMULA_FUNCTION capability requires formulas contribution in manifest')
          result.valid = false
        }
        break

      case PluginCapability.FIELD_TYPE:
        if (!manifest.contributes?.fieldTypes || manifest.contributes.fieldTypes.length === 0) {
          result.errors.push('FIELD_TYPE capability requires fieldTypes contribution in manifest')
          result.valid = false
        }
        break

      case PluginCapability.WORKFLOW_NODE:
        if (!manifest.contributes?.triggers && !manifest.contributes?.actions) {
          result.errors.push('WORKFLOW_NODE capability requires triggers or actions contribution in manifest')
          result.valid = false
        }
        break

      case PluginCapability.API_ENDPOINT:
        if (!manifest.main?.backend) {
          result.errors.push('API_ENDPOINT capability requires backend entry point in manifest')
          result.valid = false
        }
        break

      case PluginCapability.SETTINGS_PAGE:
        if (!manifest.contributes?.configuration) {
          result.warnings.push('SETTINGS_PAGE capability should include configuration contribution in manifest')
        }
        break
    }

    return result
  }

  /**
   * 生成能力兼容性报告
   */
  generateCompatibilityReport(capabilities: PluginCapability[]): {
    compatible: boolean
    issues: Array<{ type: 'error' | 'warning'; message: string }>
    suggestions: string[]
  } {
    const issues: Array<{ type: 'error' | 'warning'; message: string }> = []
    const suggestions: string[] = []

    // 检查依赖
    const allRequired = this.resolveDependencies(capabilities)
    const missing = allRequired.filter(cap => !capabilities.includes(cap))

    if (missing.length > 0) {
      issues.push({
        type: 'error',
        message: `Missing required capabilities: ${missing.join(', ')}`
      })
      suggestions.push(`Add the following capabilities to your plugin: ${missing.join(', ')}`)
    }

    // 检查冲突
    const conflicts = this.findConflicts(capabilities)
    if (conflicts.length > 0) {
      issues.push({
        type: 'error',
        message: `Conflicting capabilities: ${conflicts.join(', ')}`
      })
      suggestions.push(`Remove conflicting capabilities or choose an alternative approach`)
    }

    // 性能建议
    if (capabilities.length > 10) {
      issues.push({
        type: 'warning',
        message: 'Plugin declares many capabilities, which may impact performance'
      })
      suggestions.push('Consider splitting functionality into multiple focused plugins')
    }

    return {
      compatible: issues.filter(i => i.type === 'error').length === 0,
      issues,
      suggestions
    }
  }

  /**
   * 清理所有注册
   */
  clear(): void {
    this.registrations.clear()
    this.pluginCapabilities.clear()
    this.emit('capabilities:cleared')
  }
}

/**
 * 能力工具函数
 */
export const CapabilityUtils = {
  /**
   * 获取能力的描述
   */
  getDescription(capability: PluginCapability): string {
    return CAPABILITY_DESCRIPTIONS[capability] || '未知能力'
  },

  /**
   * 获取能力的优先级
   */
  getPriority(capability: PluginCapability): number {
    return CAPABILITY_PRIORITY[capability] || 0
  },

  /**
   * 检查两个能力是否冲突
   */
  areConflicting(cap1: PluginCapability, cap2: PluginCapability): boolean {
    const conflicts1 = CAPABILITY_CONFLICTS[cap1] || []
    const conflicts2 = CAPABILITY_CONFLICTS[cap2] || []
    return conflicts1.includes(cap2) || conflicts2.includes(cap1)
  },

  /**
   * 获取能力的依赖
   */
  getDependencies(capability: PluginCapability): PluginCapability[] {
    return CAPABILITY_DEPENDENCIES[capability] || []
  },

  /**
   * 获取能力所需的权限
   */
  getRequiredPermissions(capability: PluginCapability): string[] {
    return CAPABILITY_PERMISSIONS[capability] || []
  },

  /**
   * 按优先级排序能力
   */
  sortByPriority(capabilities: PluginCapability[]): PluginCapability[] {
    return capabilities.sort((a, b) => CAPABILITY_PRIORITY[b] - CAPABILITY_PRIORITY[a])
  }
}
