/**
 * Plugin Loader
 * Handles loading and initializing plugins
 */

import * as path from 'path'
import * as fs from 'fs'
import type { PluginManifest, PluginLifecycle } from '../types/plugin'
import { Logger } from './logger'

export interface LoadOptions {
  basePath?: string
  validate?: boolean
  isolate?: boolean
}

export interface LoadedPlugin {
  manifest: PluginManifest
  plugin: PluginLifecycle
  path: string
  loadedAt: Date
}

export class PluginLoader {
  private logger = new Logger('PluginLoader')
  private loadedPlugins = new Map<string, LoadedPlugin>()
  private basePath: string

  constructor(basePathOrCoreAPI: string | unknown = './plugins') {
    // Accept either a string path or a CoreAPI object (for backwards compatibility)
    if (typeof basePathOrCoreAPI === 'string') {
      this.basePath = basePathOrCoreAPI
    } else {
      // If CoreAPI is passed, use default plugins path
      this.basePath = './plugins'
    }
  }

  /**
   * Load a plugin from a directory
   */
  async load(pluginPath: string, options?: LoadOptions): Promise<LoadedPlugin | null> {
    const fullPath = path.resolve(options?.basePath || this.basePath, pluginPath)

    try {
      // Check if directory exists
      if (!fs.existsSync(fullPath)) {
        throw new Error(`Plugin directory not found: ${fullPath}`)
      }

      // Load manifest
      const manifestPath = path.join(fullPath, 'manifest.json')
      if (!fs.existsSync(manifestPath)) {
        throw new Error(`Plugin manifest not found: ${manifestPath}`)
      }

      const manifestContent = fs.readFileSync(manifestPath, 'utf-8')
      const manifest: PluginManifest = JSON.parse(manifestContent)

      // Validate manifest
      if (options?.validate !== false) {
        this.validateManifest(manifest)
      }

      // Determine entry point
      const mainEntry = manifest.main?.backend || 'index.js'
      const entryPath = path.join(fullPath, mainEntry)
      if (!fs.existsSync(entryPath)) {
        throw new Error(`Plugin entry point not found: ${entryPath}`)
      }

      // Dynamic import
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pluginModule = require(entryPath)
      const pluginExport = pluginModule.default || pluginModule

      const loadedPlugin: LoadedPlugin = {
        manifest,
        plugin: pluginExport,
        path: fullPath,
        loadedAt: new Date()
      }

      this.loadedPlugins.set(manifest.name, loadedPlugin)
      this.logger.info(`Plugin loaded: ${manifest.name} v${manifest.version}`)

      return loadedPlugin
    } catch (error) {
      this.logger.error(`Failed to load plugin from ${pluginPath}:`, error instanceof Error ? error : undefined)
      return null
    }
  }

  /**
   * Unload a plugin
   */
  unload(pluginId: string): boolean {
    const loaded = this.loadedPlugins.get(pluginId)
    if (!loaded) return false

    // Call deactivate if available
    if (loaded.plugin.deactivate) {
      try {
        // Fire and forget - we can't await in sync method
        void loaded.plugin.deactivate()
      } catch (error) {
        this.logger.error(`Error during plugin deactivation: ${pluginId}`, error instanceof Error ? error : undefined)
      }
    }

    this.loadedPlugins.delete(pluginId)
    this.logger.info(`Plugin unloaded: ${pluginId}`)
    return true
  }

  /**
   * Get a loaded plugin
   */
  get(pluginId: string): LoadedPlugin | undefined {
    return this.loadedPlugins.get(pluginId)
  }

  /**
   * Get all loaded plugins
   */
  getAll(): LoadedPlugin[] {
    return Array.from(this.loadedPlugins.values())
  }

  /**
   * Validate plugin manifest
   */
  private validateManifest(manifest: PluginManifest): void {
    if (!manifest.name) throw new Error('Plugin manifest missing name')
    if (!manifest.version) throw new Error('Plugin manifest missing version')
  }

  /**
   * Discover plugins in base directory
   */
  async discover(): Promise<string[]> {
    const discoveredPlugins: string[] = []

    try {
      if (!fs.existsSync(this.basePath)) {
        fs.mkdirSync(this.basePath, { recursive: true })
        return []
      }

      const entries = fs.readdirSync(this.basePath, { withFileTypes: true })

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const manifestPath = path.join(this.basePath, entry.name, 'manifest.json')
          if (fs.existsSync(manifestPath)) {
            discoveredPlugins.push(entry.name)
          }
        }
      }
    } catch (error) {
      this.logger.error('Failed to discover plugins:', error instanceof Error ? error : undefined)
    }

    return discoveredPlugins
  }

  /**
   * Get all loaded plugins as Map entries
   */
  getPlugins(): Map<string, LoadedPlugin> {
    return new Map(this.loadedPlugins)
  }

  /**
   * Load all plugins from the base directory
   */
  async loadPlugins(): Promise<LoadedPlugin[]> {
    const discovered = await this.discover()
    const loaded: LoadedPlugin[] = []

    for (const pluginName of discovered) {
      const plugin = await this.load(pluginName)
      if (plugin) {
        loaded.push(plugin)
      }
    }

    return loaded
  }

  /**
   * Reload a plugin
   */
  async reloadPlugin(pluginId: string): Promise<LoadedPlugin | null> {
    const existing = this.loadedPlugins.get(pluginId)
    if (!existing) {
      this.logger.warn(`Plugin not found for reload: ${pluginId}`)
      return null
    }

    // Unload first
    this.unload(pluginId)

    // Clear require cache for the plugin
    const pluginPath = existing.path
    Object.keys(require.cache).forEach(key => {
      if (key.startsWith(pluginPath)) {
        delete require.cache[key]
      }
    })

    // Reload
    return this.load(path.basename(pluginPath))
  }

  /**
   * Unload a plugin by name (alias for unload)
   */
  unloadPlugin(pluginId: string): boolean {
    return this.unload(pluginId)
  }

  /**
   * Unload all plugins
   */
  async unloadAll(): Promise<void> {
    const pluginIds = Array.from(this.loadedPlugins.keys())
    for (const pluginId of pluginIds) {
      this.unload(pluginId)
    }
    this.logger.info('All plugins unloaded')
  }
}
