/**
 * Plugin Config Manager
 * Manages plugin configuration storage and retrieval
 */

import { Logger } from './logger'

export interface PluginConfigSchema {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  required?: boolean
  default?: unknown
  description?: string
  validation?: {
    min?: number
    max?: number
    pattern?: string
    enum?: unknown[]
  }
}

export interface PluginConfigDefinition {
  [key: string]: PluginConfigSchema
}

export class PluginConfigManager {
  private configs = new Map<string, Record<string, unknown>>()
  private schemas = new Map<string, PluginConfigDefinition>()
  private logger = new Logger('PluginConfigManager')

  /**
   * Register a plugin's config schema
   */
  registerSchema(pluginId: string, schema: PluginConfigDefinition): void {
    this.schemas.set(pluginId, schema)
    this.logger.debug(`Config schema registered for plugin: ${pluginId}`)
  }

  /**
   * Get a plugin's config
   */
  get<T = Record<string, unknown>>(pluginId: string): T | undefined {
    return this.configs.get(pluginId) as T | undefined
  }

  /**
   * Get a specific config value
   */
  getValue<T = unknown>(pluginId: string, key: string): T | undefined {
    const config = this.configs.get(pluginId)
    return config?.[key] as T | undefined
  }

  /**
   * Set plugin config
   */
  set(pluginId: string, config: Record<string, unknown>): void {
    const schema = this.schemas.get(pluginId)

    if (schema) {
      this.validateConfig(config, schema)
    }

    this.configs.set(pluginId, { ...config })
    this.logger.debug(`Config updated for plugin: ${pluginId}`)
  }

  /**
   * Update specific config values
   */
  update(pluginId: string, updates: Record<string, unknown>): void {
    const existing = this.configs.get(pluginId) || {}
    this.set(pluginId, { ...existing, ...updates })
  }

  /**
   * Delete plugin config
   */
  delete(pluginId: string): boolean {
    const result = this.configs.delete(pluginId)
    this.schemas.delete(pluginId)
    return result
  }

  /**
   * Check if config exists
   */
  has(pluginId: string): boolean {
    return this.configs.has(pluginId)
  }

  /**
   * Get default config from schema
   */
  getDefaults(pluginId: string): Record<string, unknown> {
    const schema = this.schemas.get(pluginId)
    if (!schema) return {}

    const defaults: Record<string, unknown> = {}
    for (const [key, definition] of Object.entries(schema)) {
      if (definition.default !== undefined) {
        defaults[key] = definition.default
      }
    }
    return defaults
  }

  /**
   * Validate config against schema
   */
  private validateConfig(config: Record<string, unknown>, schema: PluginConfigDefinition): void {
    for (const [key, definition] of Object.entries(schema)) {
      const value = config[key]

      // Check required
      if (definition.required && value === undefined) {
        throw new Error(`Config key '${key}' is required`)
      }

      // Check type
      if (value !== undefined) {
        const actualType = Array.isArray(value) ? 'array' : typeof value
        if (actualType !== definition.type) {
          throw new Error(`Config key '${key}' must be of type ${definition.type}`)
        }

        // Check validation rules
        if (definition.validation) {
          this.validateValue(key, value, definition.validation)
        }
      }
    }
  }

  /**
   * Validate a specific value
   */
  private validateValue(key: string, value: unknown, validation: PluginConfigSchema['validation']): void {
    if (!validation) return

    if (typeof value === 'number') {
      if (validation.min !== undefined && value < validation.min) {
        throw new Error(`Config key '${key}' must be >= ${validation.min}`)
      }
      if (validation.max !== undefined && value > validation.max) {
        throw new Error(`Config key '${key}' must be <= ${validation.max}`)
      }
    }

    if (typeof value === 'string' && validation.pattern) {
      const regex = new RegExp(validation.pattern)
      if (!regex.test(value)) {
        throw new Error(`Config key '${key}' must match pattern ${validation.pattern}`)
      }
    }

    if (validation.enum && !validation.enum.includes(value)) {
      throw new Error(`Config key '${key}' must be one of: ${validation.enum.join(', ')}`)
    }
  }
}

export const pluginConfigManager = new PluginConfigManager()
