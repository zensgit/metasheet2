/**
 * Plugin Loader
 * Handles loading and initializing plugins
 *
 * V2 Fixes:
 * - Support plugin.json (V2 format) in addition to manifest.json
 * - Handle both string and object formats for 'main' field
 * - Add zod schema validation for plugin manifests
 */

import * as path from 'path'
import * as fs from 'fs'
import { z } from 'zod'
import type { PluginManifest, PluginLifecycle } from '../types/plugin'
import { Logger } from './logger'
import { getPluginStateManager } from './plugin-state-manager'
import { coreMetrics } from '../integration/metrics/metrics'

/**
 * Cascade reload options
 */
export interface CascadeReloadOptions {
  /** Maximum depth of cascade (default: 5) */
  maxDepth?: number
  /** Whether to continue on error (default: true) */
  continueOnError?: boolean
  /** Callback for each plugin reloaded */
  onPluginReloaded?: (pluginId: string, success: boolean, error?: Error) => void
}

/**
 * Cascade reload result
 */
export interface CascadeReloadResult {
  /** Primary plugin that triggered the cascade */
  primaryPlugin: string
  /** All plugins that were reloaded */
  reloadedPlugins: string[]
  /** Plugins that failed to reload */
  failedPlugins: Array<{ pluginId: string; error: string }>
  /** Total time taken in ms */
  duration: number
}

/**
 * Zod schema for plugin manifest validation
 * Supports both V1 (manifest.json) and V2 (plugin.json) formats
 */
const PluginManifestSchema = z.object({
  // Required fields
  name: z.string().min(1, 'Plugin name is required'),
  version: z.string().regex(/^\d+\.\d+\.\d+/, 'Invalid version format (expected semver)'),

  // Optional metadata
  manifestVersion: z.string().optional(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  author: z.union([
    z.string(),
    z.object({
      name: z.string(),
      email: z.string().optional(),
      url: z.string().optional()
    })
  ]).optional(),
  license: z.string().optional(),

  // Entry points - support both string and object formats
  main: z.union([
    z.string(),  // V2 format: "dist/index.js"
    z.object({   // V1 format: { backend: "...", frontend: "..." }
      backend: z.string().optional(),
      frontend: z.string().optional()
    })
  ]).optional(),

  // Engine requirements
  engine: z.object({
    metasheet: z.string().optional(),
    node: z.string().optional()
  }).optional(),
  engines: z.object({
    metasheet: z.string().optional(),
    node: z.string().optional()
  }).optional(),

  // Capabilities - support both array and object formats
  capabilities: z.union([
    z.array(z.string()),
    z.object({
      views: z.array(z.string()).optional(),
      workflows: z.array(z.string()).optional(),
      functions: z.array(z.string()).optional()
    })
  ]).optional(),

  // Permissions - support both array and object formats
  permissions: z.union([
    z.array(z.string()),
    z.object({
      database: z.object({
        read: z.array(z.string()).optional(),
        write: z.array(z.string()).optional()
      }).optional(),
      http: z.object({
        internal: z.boolean().optional(),
        external: z.array(z.string()).optional()
      }).optional(),
      filesystem: z.object({
        read: z.array(z.string()).optional(),
        write: z.array(z.string()).optional()
      }).optional(),
      events: z.object({
        subscribe: z.array(z.string()).optional(),
        emit: z.array(z.string()).optional()
      }).optional(),
      messaging: z.object({
        subscribe: z.array(z.string()).optional(),
        publish: z.array(z.string()).optional(),
        rpc: z.array(z.string()).optional(),
        pattern: z.boolean().optional()
      }).optional()
    })
  ]).optional(),

  // Other optional fields
  dependencies: z.record(z.string()).optional(),
  peerDependencies: z.record(z.string()).optional(),
  contributes: z.record(z.unknown()).optional(),
  lifecycle: z.record(z.string()).optional(),
  activationEvents: z.array(z.string()).optional(),
  repository: z.union([
    z.string(),
    z.object({
      type: z.string().optional(),
      url: z.string()
    })
  ]).optional(),
  keywords: z.array(z.string()).optional(),
  homepage: z.string().optional()
}).passthrough() // Allow additional fields for forward compatibility

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
  private pluginDirs: string[] | null = null

  constructor(basePathOrCoreAPI: string | unknown = './plugins', options?: { pluginDirs?: string[] }) {
    // Accept either a string path or a CoreAPI object (for backwards compatibility)
    if (typeof basePathOrCoreAPI === 'string') {
      this.basePath = basePathOrCoreAPI
    } else {
      // If CoreAPI is passed, use default plugins path
      this.basePath = './plugins'
    }

    if (options?.pluginDirs?.length) {
      this.pluginDirs = options.pluginDirs
    }
  }

  /**
   * Load a plugin from a directory
   * Supports both V1 (manifest.json) and V2 (plugin.json) formats
   */
  async load(pluginPath: string, options?: LoadOptions): Promise<LoadedPlugin | null> {
    const fullPath = path.resolve(options?.basePath || this.basePath, pluginPath)

    try {
      // Check if directory exists
      if (!fs.existsSync(fullPath)) {
        throw new Error(`Plugin directory not found: ${fullPath}`)
      }

      // Load manifest - try plugin.json first (V2), then manifest.json (V1)
      const pluginJsonPath = path.join(fullPath, 'plugin.json')
      const manifestJsonPath = path.join(fullPath, 'manifest.json')

      let manifestPath: string
      if (fs.existsSync(pluginJsonPath)) {
        manifestPath = pluginJsonPath
      } else if (fs.existsSync(manifestJsonPath)) {
        manifestPath = manifestJsonPath
      } else {
        throw new Error(`Plugin manifest not found. Expected plugin.json or manifest.json in: ${fullPath}`)
      }

      const manifestContent = fs.readFileSync(manifestPath, 'utf-8')
      let rawManifest: unknown

      try {
        rawManifest = JSON.parse(manifestContent)
      } catch (parseError) {
        throw new Error(`Invalid JSON in ${path.basename(manifestPath)}: ${parseError instanceof Error ? parseError.message : 'Parse error'}`)
      }

      // Validate manifest with zod schema
      if (options?.validate !== false) {
        const result = PluginManifestSchema.safeParse(rawManifest)
        if (!result.success) {
          const errors = result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ')
          throw new Error(`Invalid plugin manifest: ${errors}`)
        }
      }

      const manifest = rawManifest as PluginManifest

      // Determine entry point - handle both string and object formats
      let mainEntry: string
      if (typeof manifest.main === 'string') {
        // V2 format: "dist/index.js" or "index.js"
        mainEntry = manifest.main
      } else if (manifest.main && typeof manifest.main === 'object') {
        // V1 format: { backend: "...", frontend: "..." }
        mainEntry = manifest.main.backend || 'index.js'
      } else {
        // Default fallback
        mainEntry = 'index.js'
      }

      const entryPath = path.join(fullPath, mainEntry)
      if (!fs.existsSync(entryPath)) {
        throw new Error(`Plugin entry point not found: ${entryPath}. Check 'main' field in ${path.basename(manifestPath)}`)
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
   * Supports both V1 (manifest.json) and V2 (plugin.json) formats
   */
  async discover(): Promise<string[]> {
    const discoveredPlugins: string[] = []
    const seen = new Set<string>()
    const scannedRoots = new Set<string>()

    const hasManifest = (dir: string) => {
      const pluginJsonPath = path.join(dir, 'plugin.json')
      const manifestJsonPath = path.join(dir, 'manifest.json')
      return fs.existsSync(pluginJsonPath) || fs.existsSync(manifestJsonPath)
    }

    const addPlugin = (dir: string) => {
      const resolved = path.resolve(dir)
      if (seen.has(resolved)) return
      seen.add(resolved)
      discoveredPlugins.push(resolved)
    }

    const scanContainer = (root: string) => {
      const resolvedRoot = path.resolve(root)
      if (scannedRoots.has(resolvedRoot)) return
      scannedRoots.add(resolvedRoot)

      if (!fs.existsSync(resolvedRoot)) {
        this.logger.warn(`Plugin directory not found: ${resolvedRoot}`)
        return
      }

      const entries = fs.readdirSync(resolvedRoot, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const candidate = path.join(resolvedRoot, entry.name)
        if (hasManifest(candidate)) {
          addPlugin(candidate)
        }
      }
    }

    const scanPath = (dir: string) => {
      const resolved = path.resolve(dir)
      if (scannedRoots.has(resolved)) return
      scannedRoots.add(resolved)

      if (!fs.existsSync(resolved)) {
        this.logger.warn(`Plugin directory not found: ${resolved}`)
        return
      }

      if (hasManifest(resolved)) {
        addPlugin(resolved)
        return
      }

      scanContainer(resolved)
    }

    try {
      if (this.pluginDirs && this.pluginDirs.length > 0) {
        for (const dir of this.pluginDirs) {
          scanPath(dir)
        }
        return discoveredPlugins
      }

      if (!fs.existsSync(this.basePath)) {
        fs.mkdirSync(this.basePath, { recursive: true })
      }

      scanContainer(this.basePath)

      const fallbackRoots = [
        path.resolve(process.cwd(), 'plugins'),
        path.resolve(process.cwd(), '..', 'plugins'),
        path.resolve(process.cwd(), '..', '..', 'plugins'),
      ]
      for (const root of fallbackRoots) {
        if (path.resolve(root) === path.resolve(this.basePath)) continue
        scanContainer(root)
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
   * Reload a plugin with state preservation (Hot Swap)
   * Sprint 7: Enhanced with beforeReload/afterReload hooks
   */
  async reloadPlugin(pluginId: string): Promise<LoadedPlugin | null> {
    const startTime = Date.now()
    const existing = this.loadedPlugins.get(pluginId)

    if (!existing) {
      this.logger.warn(`Plugin not found for reload: ${pluginId}`)
      return null
    }

    const stateManager = getPluginStateManager()
    const version = existing.manifest.version

    this.logger.info(`Starting hot swap for plugin: ${pluginId} v${version}`)

    // Step 1: Execute beforeReload hook and save state
    let stateSaved = false
    if (existing.plugin.beforeReload) {
      try {
        const state = await existing.plugin.beforeReload()
        if (state && typeof state === 'object') {
          stateSaved = await stateManager.saveState(pluginId, version, state as Record<string, unknown>)
          this.logger.debug(`beforeReload: state saved=${stateSaved} for ${pluginId}`)
        }
      } catch (error) {
        this.logger.error(`beforeReload hook failed for ${pluginId}:`, error as Error)
        coreMetrics.increment('plugin_hot_swap_hook_errors', {
          plugin: pluginId,
          hook: 'beforeReload'
        })
      }
    }

    // Step 2: Unload the plugin
    this.unload(pluginId)

    // Step 3: Clear require cache for the plugin
    const pluginPath = existing.path
    let cacheCleared = 0
    Object.keys(require.cache).forEach(key => {
      if (key.startsWith(pluginPath)) {
        delete require.cache[key]
        cacheCleared++
      }
    })
    this.logger.debug(`Cleared ${cacheCleared} cached modules for ${pluginId}`)

    // Step 4: Reload the plugin
    const reloaded = await this.load(path.basename(pluginPath))

    if (!reloaded) {
      this.logger.error(`Failed to reload plugin: ${pluginId}`)
      coreMetrics.increment('plugin_hot_swap_failures', { plugin: pluginId })
      return null
    }

    // Step 5: Execute afterReload hook with restored state
    if (reloaded.plugin.afterReload) {
      try {
        const result = stateManager.restoreState(pluginId, reloaded.manifest.version)
        const restoredState = result.success && result.state ? result.state.data : null

        await reloaded.plugin.afterReload(restoredState)

        this.logger.debug(`afterReload: state restored=${result.success} for ${pluginId}`)
      } catch (error) {
        this.logger.error(`afterReload hook failed for ${pluginId}:`, error as Error)
        coreMetrics.increment('plugin_hot_swap_hook_errors', {
          plugin: pluginId,
          hook: 'afterReload'
        })
      }
    }

    const duration = Date.now() - startTime
    coreMetrics.increment('plugin_hot_swap_total', { plugin: pluginId })
    coreMetrics.histogram('plugin_hot_swap_duration_ms', duration, { plugin: pluginId })

    this.logger.info(`Hot swap completed for ${pluginId} v${reloaded.manifest.version} in ${duration}ms`)

    return reloaded
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

  /**
   * Get plugins that depend on the specified plugin
   * Sprint 7: Used for cascade reload
   */
  getDependents(pluginId: string): string[] {
    const dependents: string[] = []

    for (const [name, loadedPlugin] of this.loadedPlugins) {
      if (name === pluginId) continue

      const deps = loadedPlugin.manifest.dependencies
      if (deps && pluginId in deps) {
        dependents.push(name)
      }
    }

    return dependents
  }

  /**
   * Get all transitive dependents of a plugin (plugins that depend on it, directly or indirectly)
   * Sprint 7: Used for cascade reload
   */
  getTransitiveDependents(pluginId: string, maxDepth = 5): string[] {
    const visited = new Set<string>()
    const result: string[] = []

    const collectDependents = (currentPluginId: string, depth: number) => {
      if (depth > maxDepth || visited.has(currentPluginId)) return

      visited.add(currentPluginId)
      const directDependents = this.getDependents(currentPluginId)

      for (const dependent of directDependents) {
        if (!visited.has(dependent)) {
          result.push(dependent)
          collectDependents(dependent, depth + 1)
        }
      }
    }

    collectDependents(pluginId, 0)
    return result
  }

  /**
   * Reload a plugin and all plugins that depend on it (cascade reload)
   * Sprint 7: Full cascade reload implementation
   *
   * @param pluginId - The plugin to reload
   * @param options - Cascade reload options
   * @returns Result containing all reloaded plugins and any failures
   */
  async cascadeReload(
    pluginId: string,
    options: CascadeReloadOptions = {}
  ): Promise<CascadeReloadResult> {
    const startTime = Date.now()
    const {
      maxDepth = 5,
      continueOnError = true,
      onPluginReloaded
    } = options

    const result: CascadeReloadResult = {
      primaryPlugin: pluginId,
      reloadedPlugins: [],
      failedPlugins: [],
      duration: 0
    }

    // Check if primary plugin exists
    if (!this.loadedPlugins.has(pluginId)) {
      this.logger.error(`Cannot cascade reload: plugin ${pluginId} not found`)
      result.failedPlugins.push({
        pluginId,
        error: 'Plugin not found'
      })
      result.duration = Date.now() - startTime
      return result
    }

    // Get all transitive dependents
    const dependents = this.getTransitiveDependents(pluginId, maxDepth)
    this.logger.info(`Cascade reload for ${pluginId}: found ${dependents.length} dependent plugins`)

    // Build reload order: primary plugin first, then dependents in reverse dependency order
    // (plugins with fewer dependencies first)
    const reloadOrder = [pluginId, ...dependents]

    this.logger.info(`Cascade reload order: ${reloadOrder.join(' -> ')}`)

    // Reload each plugin in order
    for (const currentPluginId of reloadOrder) {
      try {
        const reloaded = await this.reloadPlugin(currentPluginId)

        if (reloaded) {
          result.reloadedPlugins.push(currentPluginId)
          onPluginReloaded?.(currentPluginId, true)
          this.logger.debug(`Cascade reload: ${currentPluginId} reloaded successfully`)
        } else {
          const error = 'reloadPlugin returned null'
          result.failedPlugins.push({ pluginId: currentPluginId, error })
          onPluginReloaded?.(currentPluginId, false, new Error(error))
          this.logger.warn(`Cascade reload: ${currentPluginId} failed to reload`)

          if (!continueOnError) {
            this.logger.error(`Cascade reload aborted due to failure in ${currentPluginId}`)
            break
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        result.failedPlugins.push({ pluginId: currentPluginId, error: errorMessage })
        onPluginReloaded?.(currentPluginId, false, error instanceof Error ? error : new Error(errorMessage))
        this.logger.error(`Cascade reload: ${currentPluginId} threw error:`, error instanceof Error ? error : undefined)

        if (!continueOnError) {
          this.logger.error(`Cascade reload aborted due to error in ${currentPluginId}`)
          break
        }
      }
    }

    result.duration = Date.now() - startTime

    // Metrics
    coreMetrics.increment('plugin_cascade_reload_total', { plugin: pluginId })
    coreMetrics.histogram('plugin_cascade_reload_duration_ms', result.duration, { plugin: pluginId })
    coreMetrics.gauge('plugin_cascade_reload_count', result.reloadedPlugins.length, { plugin: pluginId })

    if (result.failedPlugins.length > 0) {
      // Increment for each failed plugin
      for (let i = 0; i < result.failedPlugins.length; i++) {
        coreMetrics.increment('plugin_cascade_reload_failures', {
          plugin: pluginId
        })
      }
    }

    this.logger.info(
      `Cascade reload completed for ${pluginId}: ` +
      `${result.reloadedPlugins.length} succeeded, ` +
      `${result.failedPlugins.length} failed, ` +
      `${result.duration}ms`
    )

    return result
  }

  /**
   * Get dependency graph for all loaded plugins
   * Sprint 7: Useful for debugging and visualization
   */
  getDependencyGraph(): Map<string, { depends: string[]; dependents: string[] }> {
    const graph = new Map<string, { depends: string[]; dependents: string[] }>()

    // Initialize all plugins
    for (const [name, loadedPlugin] of this.loadedPlugins) {
      const deps = loadedPlugin.manifest.dependencies
      graph.set(name, {
        depends: deps ? Object.keys(deps) : [],
        dependents: []
      })
    }

    // Calculate dependents
    for (const [name, info] of graph) {
      for (const dep of info.depends) {
        const depInfo = graph.get(dep)
        if (depInfo) {
          depInfo.dependents.push(name)
        }
      }
    }

    return graph
  }

  /**
   * Validate dependency graph for cycles
   * Sprint 7: Prevents infinite cascade loops
   *
   * @returns Array of cycles found, empty if no cycles
   */
  detectDependencyCycles(): string[][] {
    const cycles: string[][] = []
    const visited = new Set<string>()
    const recursionStack = new Set<string>()
    const path: string[] = []

    const dfs = (pluginId: string): boolean => {
      visited.add(pluginId)
      recursionStack.add(pluginId)
      path.push(pluginId)

      const loadedPlugin = this.loadedPlugins.get(pluginId)
      if (loadedPlugin?.manifest.dependencies) {
        for (const dep of Object.keys(loadedPlugin.manifest.dependencies)) {
          if (!visited.has(dep)) {
            if (dfs(dep)) return true
          } else if (recursionStack.has(dep)) {
            // Found cycle
            const cycleStart = path.indexOf(dep)
            cycles.push([...path.slice(cycleStart), dep])
            return true
          }
        }
      }

      path.pop()
      recursionStack.delete(pluginId)
      return false
    }

    for (const [name] of this.loadedPlugins) {
      if (!visited.has(name)) {
        dfs(name)
      }
    }

    return cycles
  }
}
