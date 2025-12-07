/**
 * Plugin State Manager Tests
 * Sprint 7 Day 1: Tests for hot swap state management
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  PluginStateManager,
  getPluginStateManager,
  resetPluginStateManager,
  type HotSwapHooks
} from '../core/plugin-state-manager'

describe('PluginStateManager', () => {
  let stateManager: PluginStateManager

  beforeEach(() => {
    stateManager = new PluginStateManager({
      maxSizeBytes: 1024 * 1024, // 1MB for tests
      ttlMs: 60 * 1000 // 1 minute for tests
    })
  })

  afterEach(() => {
    stateManager.shutdown()
  })

  describe('saveState', () => {
    it('should save plugin state successfully', async () => {
      const result = await stateManager.saveState('test-plugin', '1.0.0', {
        counter: 42,
        name: 'test'
      })

      expect(result).toBe(true)
      expect(stateManager.hasState('test-plugin')).toBe(true)
    })

    it('should reject state exceeding max size', async () => {
      const largeState = { data: 'x'.repeat(2 * 1024 * 1024) } // 2MB
      const result = await stateManager.saveState('test-plugin', '1.0.0', largeState)

      expect(result).toBe(false)
      expect(stateManager.hasState('test-plugin')).toBe(false)
    })

    it('should include metadata in saved state', async () => {
      await stateManager.saveState('test-plugin', '1.0.0', {
        key1: 'value1',
        key2: 'value2'
      })

      const metadata = stateManager.getStateMetadata('test-plugin')
      expect(metadata).not.toBeNull()
      expect(metadata?.keys).toEqual(['key1', 'key2'])
      expect(metadata?.sizeBytes).toBeGreaterThan(0)
    })
  })

  describe('restoreState', () => {
    it('should restore saved state successfully', async () => {
      const originalState = { counter: 42, name: 'test' }
      await stateManager.saveState('test-plugin', '1.0.0', originalState)

      const result = stateManager.restoreState('test-plugin')

      expect(result.success).toBe(true)
      expect(result.state?.data).toEqual(originalState)
      expect(result.state?.version).toBe('1.0.0')
    })

    it('should return null for non-existent state', () => {
      const result = stateManager.restoreState('non-existent')

      expect(result.success).toBe(false)
      expect(result.state).toBeNull()
    })

    it('should detect version mismatch', async () => {
      await stateManager.saveState('test-plugin', '1.0.0', { data: 'test' })

      const result = stateManager.restoreState('test-plugin', '2.0.0')

      expect(result.success).toBe(false)
      expect(result.versionMismatch).toBe(true)
      expect(result.state).not.toBeNull()
    })

    it('should remove state after successful restore', async () => {
      await stateManager.saveState('test-plugin', '1.0.0', { data: 'test' })

      stateManager.restoreState('test-plugin')

      expect(stateManager.hasState('test-plugin')).toBe(false)
    })

    it('should detect expired state', async () => {
      // Create manager with very short TTL
      const shortTtlManager = new PluginStateManager({
        ttlMs: 1 // 1ms TTL
      })

      await shortTtlManager.saveState('test-plugin', '1.0.0', { data: 'test' })

      // Wait for expiry
      await new Promise(resolve => setTimeout(resolve, 10))

      const result = shortTtlManager.restoreState('test-plugin')

      expect(result.success).toBe(false)
      expect(result.expired).toBe(true)

      shortTtlManager.shutdown()
    })
  })

  describe('hooks', () => {
    it('should register and retrieve hooks', () => {
      const hooks: HotSwapHooks = {
        beforeReload: vi.fn().mockResolvedValue({ counter: 1 }),
        afterReload: vi.fn()
      }

      stateManager.registerHooks('test-plugin', hooks)

      expect(stateManager.getHooks('test-plugin')).toBe(hooks)
    })

    it('should unregister hooks', () => {
      const hooks: HotSwapHooks = {
        beforeReload: vi.fn()
      }

      stateManager.registerHooks('test-plugin', hooks)
      stateManager.unregisterHooks('test-plugin')

      expect(stateManager.getHooks('test-plugin')).toBeUndefined()
    })

    it('should execute beforeReload hook and save state', async () => {
      const hooks: HotSwapHooks = {
        beforeReload: vi.fn().mockResolvedValue({ counter: 42 })
      }

      stateManager.registerHooks('test-plugin', hooks)

      const result = await stateManager.executeBeforeReload('test-plugin', '1.0.0')

      expect(result).toBe(true)
      expect(hooks.beforeReload).toHaveBeenCalled()
      expect(stateManager.hasState('test-plugin')).toBe(true)
    })

    it('should execute afterReload hook with restored state', async () => {
      const afterReloadFn = vi.fn()
      const hooks: HotSwapHooks = {
        beforeReload: vi.fn().mockResolvedValue({ counter: 42 }),
        afterReload: afterReloadFn
      }

      stateManager.registerHooks('test-plugin', hooks)

      // Save state first
      await stateManager.executeBeforeReload('test-plugin', '1.0.0')

      // Execute afterReload
      await stateManager.executeAfterReload('test-plugin', '1.0.0')

      expect(afterReloadFn).toHaveBeenCalledWith({ counter: 42 })
    })

    it('should pass null to afterReload when no state exists', async () => {
      const afterReloadFn = vi.fn()
      const hooks: HotSwapHooks = {
        afterReload: afterReloadFn
      }

      stateManager.registerHooks('test-plugin', hooks)

      await stateManager.executeAfterReload('test-plugin')

      expect(afterReloadFn).toHaveBeenCalledWith(null)
    })

    it('should use custom serializer when provided', async () => {
      const customSerializer = {
        serialize: vi.fn((state: { value: number }) => ({ serialized: state.value * 2 })),
        deserialize: vi.fn((data: { serialized: number }) => ({ value: data.serialized / 2 }))
      }

      const afterReloadFn = vi.fn()
      const hooks: HotSwapHooks = {
        beforeReload: vi.fn().mockResolvedValue({ value: 21 }),
        afterReload: afterReloadFn,
        stateSerializer: customSerializer
      }

      stateManager.registerHooks('test-plugin', hooks)

      await stateManager.executeBeforeReload('test-plugin', '1.0.0')

      expect(customSerializer.serialize).toHaveBeenCalledWith({ value: 21 })

      await stateManager.executeAfterReload('test-plugin', '1.0.0')

      expect(customSerializer.deserialize).toHaveBeenCalledWith({ serialized: 42 })
      expect(afterReloadFn).toHaveBeenCalledWith({ value: 21 })
    })

    it('should handle beforeReload hook errors gracefully', async () => {
      const hooks: HotSwapHooks = {
        beforeReload: vi.fn().mockRejectedValue(new Error('Hook error'))
      }

      stateManager.registerHooks('test-plugin', hooks)

      const result = await stateManager.executeBeforeReload('test-plugin', '1.0.0')

      expect(result).toBe(false)
      expect(stateManager.hasState('test-plugin')).toBe(false)
    })

    it('should handle afterReload hook errors gracefully', async () => {
      const hooks: HotSwapHooks = {
        afterReload: vi.fn().mockRejectedValue(new Error('Hook error'))
      }

      stateManager.registerHooks('test-plugin', hooks)
      await stateManager.saveState('test-plugin', '1.0.0', { data: 'test' })

      const result = await stateManager.executeAfterReload('test-plugin', '1.0.0')

      expect(result).toBe(false)
    })
  })

  describe('stats', () => {
    it('should return correct statistics', async () => {
      await stateManager.saveState('plugin-1', '1.0.0', { data: 'test1' })
      await stateManager.saveState('plugin-2', '1.0.0', { data: 'test2' })

      const stats = stateManager.getStats()

      expect(stats.totalPlugins).toBe(2)
      expect(stats.totalSizeBytes).toBeGreaterThan(0)
      expect(stats.oldestState).toBeInstanceOf(Date)
      expect(stats.plugins).toContain('plugin-1')
      expect(stats.plugins).toContain('plugin-2')
    })

    it('should return empty stats when no states', () => {
      const stats = stateManager.getStats()

      expect(stats.totalPlugins).toBe(0)
      expect(stats.totalSizeBytes).toBe(0)
      expect(stats.oldestState).toBeNull()
      expect(stats.plugins).toEqual([])
    })
  })

  describe('clearState', () => {
    it('should clear specific plugin state', async () => {
      await stateManager.saveState('plugin-1', '1.0.0', { data: 'test1' })
      await stateManager.saveState('plugin-2', '1.0.0', { data: 'test2' })

      const cleared = stateManager.clearState('plugin-1')

      expect(cleared).toBe(true)
      expect(stateManager.hasState('plugin-1')).toBe(false)
      expect(stateManager.hasState('plugin-2')).toBe(true)
    })

    it('should return false for non-existent state', () => {
      const cleared = stateManager.clearState('non-existent')
      expect(cleared).toBe(false)
    })

    it('should clear all states', async () => {
      await stateManager.saveState('plugin-1', '1.0.0', { data: 'test1' })
      await stateManager.saveState('plugin-2', '1.0.0', { data: 'test2' })

      stateManager.clearAllStates()

      expect(stateManager.hasState('plugin-1')).toBe(false)
      expect(stateManager.hasState('plugin-2')).toBe(false)
      expect(stateManager.getStats().totalPlugins).toBe(0)
    })
  })

  describe('singleton', () => {
    afterEach(() => {
      resetPluginStateManager()
    })

    it('should return same instance', () => {
      const instance1 = getPluginStateManager()
      const instance2 = getPluginStateManager()

      expect(instance1).toBe(instance2)
    })

    it('should reset singleton', () => {
      const instance1 = getPluginStateManager()
      resetPluginStateManager()
      const instance2 = getPluginStateManager()

      expect(instance1).not.toBe(instance2)
    })
  })
})
