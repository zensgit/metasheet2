/**
 * Plugin Capability Manager
 * Manages and validates plugin capability declarations
 */

import { z } from 'zod'
import { Logger } from './logger'
import { PluginCapabilities } from './PluginContext'

// Capability validation schemas
const DatabaseCapabilitySchema = z.object({
  read: z.array(z.string()).optional(),
  write: z.array(z.string()).optional(),
  execute: z.boolean().optional()
}).optional()

const HttpCapabilitySchema = z.object({
  internal: z.boolean().optional(),
  external: z.boolean().optional(),
  allowedDomains: z.array(z.string()).optional()
}).optional()

const FilesystemCapabilitySchema = z.object({
  read: z.array(z.string()).optional(),
  write: z.array(z.string()).optional(),
  temp: z.boolean().optional()
}).optional()

const EventsCapabilitySchema = z.object({
  emit: z.array(z.string()).optional(),
  listen: z.array(z.string()).optional()
}).optional()

const SystemCapabilitySchema = z.object({
  env: z.array(z.string()).optional(),
  spawn: z.boolean().optional(),
  network: z.boolean().optional()
}).optional()

const UICapabilitySchema = z.object({
  views: z.boolean().optional(),
  modals: z.boolean().optional(),
  notifications: z.boolean().optional()
}).optional()

export const PluginCapabilitiesSchema = z.object({
  database: DatabaseCapabilitySchema,
  http: HttpCapabilitySchema,
  filesystem: FilesystemCapabilitySchema,
  events: EventsCapabilitySchema,
  system: SystemCapabilitySchema,
  ui: UICapabilitySchema
})

// Capability levels for progressive enhancement
export enum CapabilityLevel {
  MINIMAL = 'minimal',      // Basic read-only access
  STANDARD = 'standard',    // Standard read/write access
  ENHANCED = 'enhanced',    // Enhanced features like transactions
  PRIVILEGED = 'privileged' // Full system access
}

// Predefined capability templates
export const CAPABILITY_TEMPLATES: Record<CapabilityLevel, PluginCapabilities> = {
  [CapabilityLevel.MINIMAL]: {
    database: {
      read: ['spreadsheets', 'users']
    },
    http: {
      internal: true,
      external: false
    },
    events: {
      listen: ['spreadsheet:update', 'user:login']
    }
  },

  [CapabilityLevel.STANDARD]: {
    database: {
      read: ['spreadsheets', 'users', 'departments', 'workflows'],
      write: ['spreadsheets', 'spreadsheet_cells']
    },
    http: {
      internal: true,
      external: true,
      allowedDomains: ['api.metasheet.io']
    },
    filesystem: {
      temp: true
    },
    events: {
      emit: ['plugin:data', 'plugin:notification'],
      listen: ['spreadsheet:update', 'user:login', 'workflow:trigger']
    },
    ui: {
      views: true,
      notifications: true
    }
  },

  [CapabilityLevel.ENHANCED]: {
    database: {
      read: ['*'],
      write: ['spreadsheets', 'spreadsheet_cells', 'workflows', 'approvals'],
      execute: false
    },
    http: {
      internal: true,
      external: true
    },
    filesystem: {
      read: ['/tmp', '/var/metasheet/plugins'],
      write: ['/tmp'],
      temp: true
    },
    events: {
      emit: ['*'],
      listen: ['*']
    },
    system: {
      env: ['NODE_ENV', 'PLUGIN_CONFIG'],
      network: true
    },
    ui: {
      views: true,
      modals: true,
      notifications: true
    }
  },

  [CapabilityLevel.PRIVILEGED]: {
    database: {
      read: ['*'],
      write: ['*'],
      execute: true
    },
    http: {
      internal: true,
      external: true
    },
    filesystem: {
      read: ['*'],
      write: ['/tmp', '/var/metasheet'],
      temp: true
    },
    events: {
      emit: ['*'],
      listen: ['*']
    },
    system: {
      env: ['*'],
      spawn: true,
      network: true
    },
    ui: {
      views: true,
      modals: true,
      notifications: true
    }
  }
}

// Security policies for capability validation
export interface SecurityPolicy {
  maxDatabaseTables?: number
  maxHttpDomains?: number
  maxFilePaths?: number
  allowExecute?: boolean
  allowSpawn?: boolean
  allowNetworkAccess?: boolean
  requireSignature?: boolean
}

const DEFAULT_SECURITY_POLICY: SecurityPolicy = {
  maxDatabaseTables: 10,
  maxHttpDomains: 5,
  maxFilePaths: 3,
  allowExecute: false,
  allowSpawn: false,
  allowNetworkAccess: true,
  requireSignature: true
}

export class PluginCapabilityManager {
  private logger: Logger
  private policy: SecurityPolicy
  private capabilityCache: Map<string, PluginCapabilities> = new Map()
  private approvedCapabilities: Map<string, Set<string>> = new Map()

  constructor(policy?: SecurityPolicy) {
    this.logger = new Logger('PluginCapabilityManager')
    this.policy = { ...DEFAULT_SECURITY_POLICY, ...policy }
  }

  /**
   * Validate plugin capabilities against schema and security policy
   */
  validateCapabilities(
    pluginId: string,
    capabilities: any,
    level?: CapabilityLevel
  ): PluginCapabilities {
    try {
      // Parse with Zod schema
      const parsed = PluginCapabilitiesSchema.parse(capabilities)

      // Apply security policy
      this.applySecurityPolicy(parsed)

      // If level specified, merge with template
      if (level) {
        const template = CAPABILITY_TEMPLATES[level]
        const merged = this.mergeCapabilities(template, parsed)
        this.capabilityCache.set(pluginId, merged)
        return merged
      }

      this.capabilityCache.set(pluginId, parsed)
      return parsed
    } catch (error) {
      this.logger.error(`Invalid capabilities for plugin ${pluginId}: ${error}`)
      throw new Error(`Invalid plugin capabilities: ${error}`)
    }
  }

  /**
   * Apply security policy to capabilities
   */
  private applySecurityPolicy(capabilities: PluginCapabilities): void {
    // Check database table limits
    if (capabilities.database) {
      const tableCount =
        (capabilities.database.read?.length || 0) +
        (capabilities.database.write?.length || 0)

      if (tableCount > this.policy.maxDatabaseTables!) {
        throw new Error(`Plugin exceeds maximum table access limit (${this.policy.maxDatabaseTables})`)
      }

      if (capabilities.database.execute && !this.policy.allowExecute) {
        throw new Error('Database execute permission not allowed by security policy')
      }
    }

    // Check HTTP domain limits
    if (capabilities.http?.allowedDomains) {
      if (capabilities.http.allowedDomains.length > this.policy.maxHttpDomains!) {
        throw new Error(`Plugin exceeds maximum HTTP domain limit (${this.policy.maxHttpDomains})`)
      }
    }

    // Check filesystem path limits
    if (capabilities.filesystem) {
      const pathCount =
        (capabilities.filesystem.read?.length || 0) +
        (capabilities.filesystem.write?.length || 0)

      if (pathCount > this.policy.maxFilePaths!) {
        throw new Error(`Plugin exceeds maximum file path limit (${this.policy.maxFilePaths})`)
      }
    }

    // Check system capabilities
    if (capabilities.system) {
      if (capabilities.system.spawn && !this.policy.allowSpawn) {
        throw new Error('Process spawn permission not allowed by security policy')
      }

      if (capabilities.system.network && !this.policy.allowNetworkAccess) {
        throw new Error('Network access not allowed by security policy')
      }
    }
  }

  /**
   * Merge capabilities with template
   */
  private mergeCapabilities(
    template: PluginCapabilities,
    custom: PluginCapabilities
  ): PluginCapabilities {
    const merged: PluginCapabilities = {}

    // Merge database capabilities
    if (template.database || custom.database) {
      merged.database = {
        read: this.mergeArrays(template.database?.read, custom.database?.read),
        write: this.mergeArrays(template.database?.write, custom.database?.write),
        execute: custom.database?.execute ?? template.database?.execute
      }
    }

    // Merge HTTP capabilities
    if (template.http || custom.http) {
      merged.http = {
        internal: custom.http?.internal ?? template.http?.internal,
        external: custom.http?.external ?? template.http?.external,
        allowedDomains: this.mergeArrays(
          template.http?.allowedDomains,
          custom.http?.allowedDomains
        )
      }
    }

    // Merge filesystem capabilities
    if (template.filesystem || custom.filesystem) {
      merged.filesystem = {
        read: this.mergeArrays(template.filesystem?.read, custom.filesystem?.read),
        write: this.mergeArrays(template.filesystem?.write, custom.filesystem?.write),
        temp: custom.filesystem?.temp ?? template.filesystem?.temp
      }
    }

    // Merge events capabilities
    if (template.events || custom.events) {
      merged.events = {
        emit: this.mergeArrays(template.events?.emit, custom.events?.emit),
        listen: this.mergeArrays(template.events?.listen, custom.events?.listen)
      }
    }

    // Merge system capabilities
    if (template.system || custom.system) {
      merged.system = {
        env: this.mergeArrays(template.system?.env, custom.system?.env),
        spawn: custom.system?.spawn ?? template.system?.spawn,
        network: custom.system?.network ?? template.system?.network
      }
    }

    // Merge UI capabilities
    if (template.ui || custom.ui) {
      merged.ui = {
        views: custom.ui?.views ?? template.ui?.views,
        modals: custom.ui?.modals ?? template.ui?.modals,
        notifications: custom.ui?.notifications ?? template.ui?.notifications
      }
    }

    return merged
  }

  /**
   * Merge arrays with deduplication
   */
  private mergeArrays<T>(arr1?: T[], arr2?: T[]): T[] | undefined {
    if (!arr1 && !arr2) return undefined
    if (!arr1) return arr2
    if (!arr2) return arr1

    const set = new Set([...arr1, ...arr2])
    return Array.from(set) as T[]
  }

  /**
   * Request capability approval
   */
  async requestCapabilityApproval(
    pluginId: string,
    capability: string,
    reason?: string
  ): Promise<boolean> {
    // In production, this would trigger an approval workflow
    this.logger.info(`Plugin ${pluginId} requesting capability: ${capability}`)

    if (reason) {
      this.logger.info(`Reason: ${reason}`)
    }

    // For now, auto-approve in development
    if (process.env.NODE_ENV === 'development') {
      this.approveCapability(pluginId, capability)
      return true
    }

    return false
  }

  /**
   * Approve a capability for a plugin
   */
  approveCapability(pluginId: string, capability: string): void {
    if (!this.approvedCapabilities.has(pluginId)) {
      this.approvedCapabilities.set(pluginId, new Set())
    }

    this.approvedCapabilities.get(pluginId)!.add(capability)
    this.logger.info(`Approved capability ${capability} for plugin ${pluginId}`)
  }

  /**
   * Check if a plugin has an approved capability
   */
  hasApprovedCapability(pluginId: string, capability: string): boolean {
    return this.approvedCapabilities.get(pluginId)?.has(capability) || false
  }

  /**
   * Get plugin capability level
   */
  getCapabilityLevel(capabilities: PluginCapabilities): CapabilityLevel {
    // Determine level based on capabilities
    if (capabilities.database?.execute || capabilities.system?.spawn) {
      return CapabilityLevel.PRIVILEGED
    }

    if (capabilities.database?.write && capabilities.database.write.length > 0) {
      return CapabilityLevel.ENHANCED
    }

    if (capabilities.http?.external || capabilities.ui?.views) {
      return CapabilityLevel.STANDARD
    }

    return CapabilityLevel.MINIMAL
  }

  /**
   * Generate capability report for a plugin
   */
  generateCapabilityReport(pluginId: string): any {
    const capabilities = this.capabilityCache.get(pluginId)
    if (!capabilities) {
      return null
    }

    const level = this.getCapabilityLevel(capabilities)
    const approved = Array.from(this.approvedCapabilities.get(pluginId) || [])

    return {
      pluginId,
      level,
      capabilities,
      approved,
      summary: this.generateCapabilitySummary(capabilities)
    }
  }

  /**
   * Generate human-readable capability summary
   */
  private generateCapabilitySummary(capabilities: PluginCapabilities): string[] {
    const summary: string[] = []

    if (capabilities.database) {
      if (capabilities.database.execute) {
        summary.push('Can execute arbitrary SQL queries')
      }
      if (capabilities.database.read?.includes('*')) {
        summary.push('Can read all database tables')
      } else if (capabilities.database.read?.length) {
        summary.push(`Can read ${capabilities.database.read.length} tables`)
      }
      if (capabilities.database.write?.includes('*')) {
        summary.push('Can write to all database tables')
      } else if (capabilities.database.write?.length) {
        summary.push(`Can write to ${capabilities.database.write.length} tables`)
      }
    }

    if (capabilities.http) {
      if (capabilities.http.external) {
        summary.push('Can make external HTTP requests')
      }
      if (capabilities.http.allowedDomains?.length) {
        summary.push(`Can access ${capabilities.http.allowedDomains.length} external domains`)
      }
    }

    if (capabilities.filesystem) {
      if (capabilities.filesystem.read?.includes('*')) {
        summary.push('Can read all files')
      } else if (capabilities.filesystem.read?.length) {
        summary.push(`Can read from ${capabilities.filesystem.read.length} directories`)
      }
      if (capabilities.filesystem.write?.length) {
        summary.push(`Can write to ${capabilities.filesystem.write.length} directories`)
      }
    }

    if (capabilities.system) {
      if (capabilities.system.spawn) {
        summary.push('Can spawn child processes')
      }
      if (capabilities.system.network) {
        summary.push('Can create network connections')
      }
    }

    if (capabilities.ui) {
      const uiFeatures = []
      if (capabilities.ui.views) uiFeatures.push('views')
      if (capabilities.ui.modals) uiFeatures.push('modals')
      if (capabilities.ui.notifications) uiFeatures.push('notifications')
      if (uiFeatures.length) {
        summary.push(`Can create UI: ${uiFeatures.join(', ')}`)
      }
    }

    return summary
  }

  /**
   * Clear capability cache
   */
  clearCache(): void {
    this.capabilityCache.clear()
    this.approvedCapabilities.clear()
  }
}

export default PluginCapabilityManager