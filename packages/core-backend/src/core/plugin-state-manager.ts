/**
 * Plugin State Manager
 * Sprint 7 Day 1: State persistence for plugin hot swap
 *
 * Provides mechanisms for plugins to save and restore state during hot reload,
 * ensuring continuity of in-memory data across plugin updates.
 */

import { Logger } from './logger'
import { coreMetrics } from '../integration/metrics/metrics'

/**
 * Serializable plugin state
 */
export interface PluginState {
  /** Plugin name */
  pluginName: string
  /** State version for compatibility checking */
  version: string
  /** Timestamp when state was saved */
  savedAt: Date
  /** Serialized state data */
  data: Record<string, unknown>
  /** Optional metadata about the state */
  metadata?: {
    /** State size in bytes (approximate) */
    sizeBytes?: number
    /** Keys in the state */
    keys?: string[]
    /** Custom metadata from plugin */
    custom?: Record<string, unknown>
  }
}

/**
 * State serializer interface - plugins can implement custom serialization
 */
export interface StateSerializer<T = unknown> {
  /** Serialize state to JSON-compatible format */
  serialize(state: T): Record<string, unknown>
  /** Deserialize state from JSON format */
  deserialize(data: Record<string, unknown>): T
  /** Validate state compatibility (optional) */
  validate?(data: Record<string, unknown>, version: string): boolean
}

/**
 * Hot swap lifecycle hooks for plugins
 */
export interface HotSwapHooks {
  /** Called before plugin reload - return state to save */
  beforeReload?(): Promise<Record<string, unknown> | void> | Record<string, unknown> | void
  /** Called after plugin reload with restored state */
  afterReload?(state: Record<string, unknown> | null): Promise<void> | void
  /** Custom state serializer */
  stateSerializer?: StateSerializer
}

/**
 * State save options
 */
export interface StateSaveOptions {
  /** Maximum state size in bytes (default: 10MB) */
  maxSizeBytes?: number
  /** State TTL in milliseconds (default: 5 minutes) */
  ttlMs?: number
  /** Whether to compress state (future feature) */
  compress?: boolean
}

/**
 * State restore result
 */
export interface StateRestoreResult {
  success: boolean
  state: PluginState | null
  error?: string
  /** Whether state was found but expired */
  expired?: boolean
  /** Whether state was found but version mismatched */
  versionMismatch?: boolean
}

const DEFAULT_OPTIONS: Required<StateSaveOptions> = {
  maxSizeBytes: 10 * 1024 * 1024, // 10MB
  ttlMs: 5 * 60 * 1000, // 5 minutes
  compress: false
}

/**
 * PluginStateManager handles state persistence during hot swap operations
 */
export class PluginStateManager {
  private readonly states = new Map<string, PluginState>()
  private readonly hooks = new Map<string, HotSwapHooks>()
  private readonly logger = new Logger('PluginStateManager')
  private readonly options: Required<StateSaveOptions>
  private cleanupTimer?: NodeJS.Timeout

  constructor(options: StateSaveOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
    this.startCleanupTimer()
  }

  /**
   * Register hot swap hooks for a plugin
   */
  registerHooks(pluginName: string, hooks: HotSwapHooks): void {
    this.hooks.set(pluginName, hooks)
    this.logger.debug(`Registered hot swap hooks for plugin: ${pluginName}`)
  }

  /**
   * Unregister hot swap hooks for a plugin
   */
  unregisterHooks(pluginName: string): void {
    this.hooks.delete(pluginName)
    this.logger.debug(`Unregistered hot swap hooks for plugin: ${pluginName}`)
  }

  /**
   * Get registered hooks for a plugin
   */
  getHooks(pluginName: string): HotSwapHooks | undefined {
    return this.hooks.get(pluginName)
  }

  /**
   * Save plugin state before hot swap
   */
  async saveState(
    pluginName: string,
    version: string,
    data: Record<string, unknown>
  ): Promise<boolean> {
    try {
      // Serialize to check size
      const serialized = JSON.stringify(data)
      const sizeBytes = Buffer.byteLength(serialized, 'utf8')

      if (sizeBytes > this.options.maxSizeBytes) {
        this.logger.warn(
          `State too large for plugin ${pluginName}: ${sizeBytes} bytes (max: ${this.options.maxSizeBytes})`
        )
        coreMetrics.increment('plugin_hot_swap_state_rejected', {
          plugin: pluginName,
          reason: 'size_exceeded'
        })
        return false
      }

      const state: PluginState = {
        pluginName,
        version,
        savedAt: new Date(),
        data,
        metadata: {
          sizeBytes,
          keys: Object.keys(data)
        }
      }

      this.states.set(pluginName, state)

      coreMetrics.increment('plugin_hot_swap_state_saved', { plugin: pluginName })
      coreMetrics.gauge('plugin_hot_swap_state_size_bytes', sizeBytes, { plugin: pluginName })

      this.logger.info(`Saved state for plugin ${pluginName} (${sizeBytes} bytes, ${state.metadata?.keys?.length} keys)`)

      return true
    } catch (error) {
      this.logger.error(`Failed to save state for plugin ${pluginName}:`, error as Error)
      coreMetrics.increment('plugin_hot_swap_state_save_errors', { plugin: pluginName })
      return false
    }
  }

  /**
   * Restore plugin state after hot swap
   */
  restoreState(pluginName: string, expectedVersion?: string): StateRestoreResult {
    const state = this.states.get(pluginName)

    if (!state) {
      this.logger.debug(`No saved state found for plugin: ${pluginName}`)
      return { success: false, state: null }
    }

    // Check TTL
    const age = Date.now() - state.savedAt.getTime()
    if (age > this.options.ttlMs) {
      this.logger.warn(`State expired for plugin ${pluginName} (age: ${age}ms, ttl: ${this.options.ttlMs}ms)`)
      this.states.delete(pluginName)
      coreMetrics.increment('plugin_hot_swap_state_expired', { plugin: pluginName })
      return { success: false, state: null, expired: true }
    }

    // Check version compatibility
    if (expectedVersion && state.version !== expectedVersion) {
      this.logger.warn(
        `State version mismatch for plugin ${pluginName}: saved=${state.version}, expected=${expectedVersion}`
      )
      coreMetrics.increment('plugin_hot_swap_state_version_mismatch', { plugin: pluginName })
      return { success: false, state, versionMismatch: true }
    }

    // Remove state after successful restore
    this.states.delete(pluginName)

    coreMetrics.increment('plugin_hot_swap_state_restored', { plugin: pluginName })
    this.logger.info(`Restored state for plugin ${pluginName} (${state.metadata?.sizeBytes} bytes)`)

    return { success: true, state }
  }

  /**
   * Execute beforeReload hook and save state
   */
  async executeBeforeReload(pluginName: string, version: string): Promise<boolean> {
    const hooks = this.hooks.get(pluginName)

    if (!hooks?.beforeReload) {
      this.logger.debug(`No beforeReload hook for plugin: ${pluginName}`)
      return true
    }

    try {
      const startTime = Date.now()
      const state = await hooks.beforeReload()

      if (state && typeof state === 'object') {
        // Use custom serializer if provided
        const data = hooks.stateSerializer
          ? hooks.stateSerializer.serialize(state)
          : state

        const saved = await this.saveState(pluginName, version, data)

        coreMetrics.histogram('plugin_hot_swap_before_reload_duration_ms', Date.now() - startTime, {
          plugin: pluginName
        })

        return saved
      }

      return true
    } catch (error) {
      this.logger.error(`beforeReload hook failed for plugin ${pluginName}:`, error as Error)
      coreMetrics.increment('plugin_hot_swap_hook_errors', {
        plugin: pluginName,
        hook: 'beforeReload'
      })
      return false
    }
  }

  /**
   * Execute afterReload hook with restored state
   */
  async executeAfterReload(pluginName: string, version?: string): Promise<boolean> {
    const hooks = this.hooks.get(pluginName)

    if (!hooks?.afterReload) {
      this.logger.debug(`No afterReload hook for plugin: ${pluginName}`)
      return true
    }

    try {
      const startTime = Date.now()
      const result = this.restoreState(pluginName, version)

      let stateData: Record<string, unknown> | null = null

      if (result.success && result.state) {
        // Use custom deserializer if provided
        stateData = hooks.stateSerializer
          ? hooks.stateSerializer.deserialize(result.state.data) as Record<string, unknown>
          : result.state.data
      }

      await hooks.afterReload(stateData)

      coreMetrics.histogram('plugin_hot_swap_after_reload_duration_ms', Date.now() - startTime, {
        plugin: pluginName
      })

      return true
    } catch (error) {
      this.logger.error(`afterReload hook failed for plugin ${pluginName}:`, error as Error)
      coreMetrics.increment('plugin_hot_swap_hook_errors', {
        plugin: pluginName,
        hook: 'afterReload'
      })
      return false
    }
  }

  /**
   * Check if a plugin has saved state
   */
  hasState(pluginName: string): boolean {
    return this.states.has(pluginName)
  }

  /**
   * Get state metadata without consuming the state
   */
  getStateMetadata(pluginName: string): PluginState['metadata'] | null {
    const state = this.states.get(pluginName)
    return state?.metadata ?? null
  }

  /**
   * Clear state for a specific plugin
   */
  clearState(pluginName: string): boolean {
    const had = this.states.has(pluginName)
    this.states.delete(pluginName)
    if (had) {
      this.logger.debug(`Cleared state for plugin: ${pluginName}`)
    }
    return had
  }

  /**
   * Clear all saved states
   */
  clearAllStates(): void {
    const count = this.states.size
    this.states.clear()
    this.logger.info(`Cleared ${count} saved plugin states`)
  }

  /**
   * Get statistics about saved states
   */
  getStats(): {
    totalPlugins: number
    totalSizeBytes: number
    oldestState: Date | null
    plugins: string[]
  } {
    let totalSizeBytes = 0
    let oldestState: Date | null = null

    for (const state of this.states.values()) {
      totalSizeBytes += state.metadata?.sizeBytes ?? 0
      if (!oldestState || state.savedAt < oldestState) {
        oldestState = state.savedAt
      }
    }

    return {
      totalPlugins: this.states.size,
      totalSizeBytes,
      oldestState,
      plugins: Array.from(this.states.keys())
    }
  }

  /**
   * Start cleanup timer for expired states
   */
  private startCleanupTimer(): void {
    // Run cleanup every minute
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredStates()
    }, 60 * 1000)

    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref()
    }
  }

  /**
   * Clean up expired states
   */
  private cleanupExpiredStates(): void {
    const now = Date.now()
    let cleanedCount = 0

    for (const [pluginName, state] of this.states) {
      const age = now - state.savedAt.getTime()
      if (age > this.options.ttlMs) {
        this.states.delete(pluginName)
        cleanedCount++
        this.logger.debug(`Cleaned up expired state for plugin: ${pluginName}`)
      }
    }

    if (cleanedCount > 0) {
      // Increment for each cleaned state
      for (let i = 0; i < cleanedCount; i++) {
        coreMetrics.increment('plugin_hot_swap_state_cleanup_total')
      }
      this.logger.info(`Cleaned up ${cleanedCount} expired plugin states`)
    }
  }

  /**
   * Shutdown the state manager
   */
  shutdown(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = undefined
    }
    this.clearAllStates()
    this.hooks.clear()
    this.logger.info('PluginStateManager shutdown complete')
  }
}

/**
 * Singleton instance
 */
let stateManagerInstance: PluginStateManager | null = null

export function getPluginStateManager(options?: StateSaveOptions): PluginStateManager {
  if (!stateManagerInstance) {
    stateManagerInstance = new PluginStateManager(options)
  }
  return stateManagerInstance
}

export function resetPluginStateManager(): void {
  if (stateManagerInstance) {
    stateManagerInstance.shutdown()
    stateManagerInstance = null
  }
}
