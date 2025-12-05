/**
 * Plugin Registry
 * Manages plugin registration and discovery
 */

import type { PluginRegistration, PluginStatus } from '../types/plugin'
import { Logger } from './logger'

// Extended registration with id field
export interface PluginRegistrationWithId extends PluginRegistration {
  id: string
}

export class PluginRegistry {
  private plugins = new Map<string, PluginRegistrationWithId>()
  private logger = new Logger('PluginRegistry')

  /**
   * Register a plugin
   */
  register(registration: PluginRegistration): void {
    const id = registration.manifest.name
    const regWithId: PluginRegistrationWithId = { ...registration, id }
    if (this.plugins.has(id)) {
      this.logger.warn(`Plugin ${id} is already registered, updating...`)
    }
    this.plugins.set(id, regWithId)
    this.logger.info(`Plugin registered: ${id}`)
  }

  /**
   * Unregister a plugin
   */
  unregister(pluginId: string): boolean {
    const result = this.plugins.delete(pluginId)
    if (result) {
      this.logger.info(`Plugin unregistered: ${pluginId}`)
    }
    return result
  }

  /**
   * Get a plugin by ID
   */
  get(pluginId: string): PluginRegistrationWithId | undefined {
    return this.plugins.get(pluginId)
  }

  /**
   * Get all registered plugins
   */
  getAll(): PluginRegistrationWithId[] {
    return Array.from(this.plugins.values())
  }

  /**
   * Get plugins by status
   */
  getByStatus(status: PluginStatus): PluginRegistrationWithId[] {
    return this.getAll().filter(p => p.status === status)
  }

  /**
   * Check if a plugin is registered
   */
  has(pluginId: string): boolean {
    return this.plugins.has(pluginId)
  }

  /**
   * Update plugin status
   */
  updateStatus(pluginId: string, status: PluginStatus): boolean {
    const plugin = this.plugins.get(pluginId)
    if (!plugin) return false

    plugin.status = status
    this.logger.debug(`Plugin ${pluginId} status updated to: ${status}`)
    return true
  }

  /**
   * Get plugin count
   */
  count(): number {
    return this.plugins.size
  }

  /**
   * Clear all registered plugins
   */
  clear(): void {
    this.plugins.clear()
    this.logger.info('Plugin registry cleared')
  }
}

export const pluginRegistry = new PluginRegistry()
