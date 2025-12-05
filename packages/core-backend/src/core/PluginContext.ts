/**
 * Plugin Context
 * Defines the context and capabilities available to plugins
 */

export interface PluginCapabilities {
  storage: boolean
  messaging: boolean
  http: boolean
  database: boolean
  scheduler: boolean
  notifications: boolean
  files: boolean
  analytics: boolean
  admin: boolean
}

export interface PluginContextConfig {
  pluginId: string
  pluginName: string
  version: string
  capabilities: Partial<PluginCapabilities>
  sandbox?: boolean
  resourceLimits?: {
    maxMemoryMB?: number
    maxCpuPercent?: number
    maxExecutionTimeMs?: number
  }
}

export class PluginContext {
  private pluginId: string
  private pluginName: string
  private version: string
  private capabilities: PluginCapabilities
  private sandbox: boolean
  private resourceLimits: {
    maxMemoryMB: number
    maxCpuPercent: number
    maxExecutionTimeMs: number
  }

  constructor(config: PluginContextConfig) {
    this.pluginId = config.pluginId
    this.pluginName = config.pluginName
    this.version = config.version
    this.capabilities = {
      storage: config.capabilities.storage ?? false,
      messaging: config.capabilities.messaging ?? false,
      http: config.capabilities.http ?? false,
      database: config.capabilities.database ?? false,
      scheduler: config.capabilities.scheduler ?? false,
      notifications: config.capabilities.notifications ?? false,
      files: config.capabilities.files ?? false,
      analytics: config.capabilities.analytics ?? false,
      admin: config.capabilities.admin ?? false
    }
    this.sandbox = config.sandbox ?? true
    this.resourceLimits = {
      maxMemoryMB: config.resourceLimits?.maxMemoryMB ?? 256,
      maxCpuPercent: config.resourceLimits?.maxCpuPercent ?? 50,
      maxExecutionTimeMs: config.resourceLimits?.maxExecutionTimeMs ?? 30000
    }
  }

  getPluginId(): string {
    return this.pluginId
  }

  getPluginName(): string {
    return this.pluginName
  }

  getVersion(): string {
    return this.version
  }

  getCapabilities(): PluginCapabilities {
    return { ...this.capabilities }
  }

  hasCapability(capability: keyof PluginCapabilities): boolean {
    return this.capabilities[capability] ?? false
  }

  isSandboxed(): boolean {
    return this.sandbox
  }

  getResourceLimits() {
    return { ...this.resourceLimits }
  }
}
