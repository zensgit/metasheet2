/**
 * Enhanced Plugin Context
 * Provides extended context for plugins with additional services
 */

import type { CoreAPI, PluginManifest, PluginServices } from '../types/plugin'
import { Logger } from './logger'
import type { PluginCapabilities } from './PluginContext'

export interface EnhancedPluginContextConfig {
  manifest: PluginManifest
  core: CoreAPI
  services: PluginServices
  capabilities: Partial<PluginCapabilities>
}

export interface EnhancedPluginContext {
  readonly pluginId: string
  readonly pluginName: string
  readonly version: string
  readonly logger: Logger
  readonly core: CoreAPI
  readonly services: PluginServices
  readonly capabilities: PluginCapabilities

  // Storage helpers
  getConfig<T = unknown>(key: string): T | undefined
  setConfig<T = unknown>(key: string, value: T): Promise<void>

  // Event helpers
  emit(event: string, data: unknown): Promise<void>
  on(event: string, handler: (data: unknown) => void): void
  off(event: string, handler: (data: unknown) => void): void
}

export function createEnhancedPluginContext(config: EnhancedPluginContextConfig): EnhancedPluginContext {
  const pluginId = config.manifest.name // use name as id
  const logger = new Logger(`Plugin:${pluginId}`)
  const configStore = new Map<string, unknown>()
  const eventHandlers = new Map<string, Set<(data: unknown) => void>>()

  const capabilities: PluginCapabilities = {
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

  return {
    pluginId,
    pluginName: config.manifest.name,
    version: config.manifest.version,
    logger,
    core: config.core,
    services: config.services,
    capabilities,

    getConfig<T = unknown>(key: string): T | undefined {
      return configStore.get(key) as T | undefined
    },

    async setConfig<T = unknown>(key: string, value: T): Promise<void> {
      configStore.set(key, value)
    },

    async emit(event: string, data: unknown): Promise<void> {
      // Use core events API instead of non-existent services.events
      const fullEvent = `plugin.${pluginId}.${event}`
      config.core.events.emit(fullEvent, data)
    },

    on(event: string, handler: (data: unknown) => void): void {
      if (!eventHandlers.has(event)) {
        eventHandlers.set(event, new Set())
      }
      eventHandlers.get(event)!.add(handler)

      // Use core events API
      const fullEvent = `plugin.${pluginId}.${event}`
      config.core.events.on(fullEvent, handler)
    },

    off(event: string, handler: (data: unknown) => void): void {
      const handlers = eventHandlers.get(event)
      if (handlers) {
        handlers.delete(handler)
      }

      // Use core events API
      const fullEvent = `plugin.${pluginId}.${event}`
      config.core.events.off(fullEvent, handler)
    }
  }
}
