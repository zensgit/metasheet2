/**
 * Plugin Cascade Reload Tests
 * Sprint 7 Day 1: Tests for cascade reload functionality
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { PluginLoader, type LoadedPlugin } from '../core/plugin-loader'

// Mock dependencies
vi.mock('../core/logger', () => ({
  Logger: class MockLogger {
    info = vi.fn()
    warn = vi.fn()
    error = vi.fn()
    debug = vi.fn()
  }
}))

vi.mock('../integration/metrics/metrics', () => ({
  coreMetrics: {
    increment: vi.fn(),
    histogram: vi.fn(),
    gauge: vi.fn()
  }
}))

vi.mock('../core/plugin-state-manager', () => ({
  getPluginStateManager: vi.fn(() => ({
    saveState: vi.fn().mockResolvedValue(true),
    restoreState: vi.fn().mockReturnValue({ success: false, state: null })
  }))
}))

describe('PluginLoader Cascade Reload', () => {
  let loader: PluginLoader

  // Helper to create mock loaded plugins
  const createMockPlugin = (
    name: string,
    dependencies?: Record<string, string>
  ): LoadedPlugin => ({
    manifest: {
      name,
      version: '1.0.0',
      dependencies
    },
    plugin: {
      activate: vi.fn().mockResolvedValue(undefined),
      deactivate: vi.fn().mockResolvedValue(undefined)
    },
    path: `/mock/plugins/${name}`,
    loadedAt: new Date()
  })

  beforeEach(() => {
    loader = new PluginLoader('/mock/plugins')
    // Clear any mocked methods
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('getDependents', () => {
    it('should return empty array when no plugins depend on given plugin', () => {
      // Add plugins without dependencies
      const pluginA = createMockPlugin('plugin-a')
      const pluginB = createMockPlugin('plugin-b')

      // Manually add to loadedPlugins map
      const loadedPlugins = (loader as unknown as { loadedPlugins: Map<string, LoadedPlugin> }).loadedPlugins
      loadedPlugins.set('plugin-a', pluginA)
      loadedPlugins.set('plugin-b', pluginB)

      const dependents = loader.getDependents('plugin-a')
      expect(dependents).toEqual([])
    })

    it('should return plugins that depend on given plugin', () => {
      const pluginA = createMockPlugin('plugin-a')
      const pluginB = createMockPlugin('plugin-b', { 'plugin-a': '^1.0.0' })
      const pluginC = createMockPlugin('plugin-c', { 'plugin-a': '^1.0.0' })

      const loadedPlugins = (loader as unknown as { loadedPlugins: Map<string, LoadedPlugin> }).loadedPlugins
      loadedPlugins.set('plugin-a', pluginA)
      loadedPlugins.set('plugin-b', pluginB)
      loadedPlugins.set('plugin-c', pluginC)

      const dependents = loader.getDependents('plugin-a')
      expect(dependents).toContain('plugin-b')
      expect(dependents).toContain('plugin-c')
      expect(dependents.length).toBe(2)
    })

    it('should not include plugin itself in dependents', () => {
      const pluginA = createMockPlugin('plugin-a', { 'plugin-a': '^1.0.0' }) // self-reference

      const loadedPlugins = (loader as unknown as { loadedPlugins: Map<string, LoadedPlugin> }).loadedPlugins
      loadedPlugins.set('plugin-a', pluginA)

      const dependents = loader.getDependents('plugin-a')
      expect(dependents).toEqual([])
    })
  })

  describe('getTransitiveDependents', () => {
    it('should return all transitive dependents', () => {
      // A <- B <- C (C depends on B, B depends on A)
      const pluginA = createMockPlugin('plugin-a')
      const pluginB = createMockPlugin('plugin-b', { 'plugin-a': '^1.0.0' })
      const pluginC = createMockPlugin('plugin-c', { 'plugin-b': '^1.0.0' })

      const loadedPlugins = (loader as unknown as { loadedPlugins: Map<string, LoadedPlugin> }).loadedPlugins
      loadedPlugins.set('plugin-a', pluginA)
      loadedPlugins.set('plugin-b', pluginB)
      loadedPlugins.set('plugin-c', pluginC)

      const dependents = loader.getTransitiveDependents('plugin-a')
      expect(dependents).toContain('plugin-b')
      expect(dependents).toContain('plugin-c')
    })

    it('should respect maxDepth parameter', () => {
      // Chain: A <- B <- C <- D <- E
      const pluginA = createMockPlugin('plugin-a')
      const pluginB = createMockPlugin('plugin-b', { 'plugin-a': '^1.0.0' })
      const pluginC = createMockPlugin('plugin-c', { 'plugin-b': '^1.0.0' })
      const pluginD = createMockPlugin('plugin-d', { 'plugin-c': '^1.0.0' })
      const pluginE = createMockPlugin('plugin-e', { 'plugin-d': '^1.0.0' })

      const loadedPlugins = (loader as unknown as { loadedPlugins: Map<string, LoadedPlugin> }).loadedPlugins
      loadedPlugins.set('plugin-a', pluginA)
      loadedPlugins.set('plugin-b', pluginB)
      loadedPlugins.set('plugin-c', pluginC)
      loadedPlugins.set('plugin-d', pluginD)
      loadedPlugins.set('plugin-e', pluginE)

      // With maxDepth=2, should get B and C (depth 1 and 2)
      const dependents = loader.getTransitiveDependents('plugin-a', 2)
      expect(dependents).toContain('plugin-b')
      expect(dependents).toContain('plugin-c')
      // D and E are beyond depth 2
    })

    it('should handle diamond dependencies without duplicates', () => {
      // Diamond: A <- B, A <- C, B <- D, C <- D
      const pluginA = createMockPlugin('plugin-a')
      const pluginB = createMockPlugin('plugin-b', { 'plugin-a': '^1.0.0' })
      const pluginC = createMockPlugin('plugin-c', { 'plugin-a': '^1.0.0' })
      const pluginD = createMockPlugin('plugin-d', { 'plugin-b': '^1.0.0', 'plugin-c': '^1.0.0' })

      const loadedPlugins = (loader as unknown as { loadedPlugins: Map<string, LoadedPlugin> }).loadedPlugins
      loadedPlugins.set('plugin-a', pluginA)
      loadedPlugins.set('plugin-b', pluginB)
      loadedPlugins.set('plugin-c', pluginC)
      loadedPlugins.set('plugin-d', pluginD)

      const dependents = loader.getTransitiveDependents('plugin-a')
      // Should not have duplicates
      expect(new Set(dependents).size).toBe(dependents.length)
      expect(dependents).toContain('plugin-b')
      expect(dependents).toContain('plugin-c')
      expect(dependents).toContain('plugin-d')
    })
  })

  describe('getDependencyGraph', () => {
    it('should build correct dependency graph', () => {
      const pluginA = createMockPlugin('plugin-a')
      const pluginB = createMockPlugin('plugin-b', { 'plugin-a': '^1.0.0' })
      const pluginC = createMockPlugin('plugin-c', { 'plugin-a': '^1.0.0', 'plugin-b': '^1.0.0' })

      const loadedPlugins = (loader as unknown as { loadedPlugins: Map<string, LoadedPlugin> }).loadedPlugins
      loadedPlugins.set('plugin-a', pluginA)
      loadedPlugins.set('plugin-b', pluginB)
      loadedPlugins.set('plugin-c', pluginC)

      const graph = loader.getDependencyGraph()

      // Check plugin-a
      const nodeA = graph.get('plugin-a')
      expect(nodeA?.depends).toEqual([])
      expect(nodeA?.dependents).toContain('plugin-b')
      expect(nodeA?.dependents).toContain('plugin-c')

      // Check plugin-b
      const nodeB = graph.get('plugin-b')
      expect(nodeB?.depends).toContain('plugin-a')
      expect(nodeB?.dependents).toContain('plugin-c')

      // Check plugin-c
      const nodeC = graph.get('plugin-c')
      expect(nodeC?.depends).toContain('plugin-a')
      expect(nodeC?.depends).toContain('plugin-b')
      expect(nodeC?.dependents).toEqual([])
    })
  })

  describe('detectDependencyCycles', () => {
    it('should return empty array when no cycles exist', () => {
      const pluginA = createMockPlugin('plugin-a')
      const pluginB = createMockPlugin('plugin-b', { 'plugin-a': '^1.0.0' })

      const loadedPlugins = (loader as unknown as { loadedPlugins: Map<string, LoadedPlugin> }).loadedPlugins
      loadedPlugins.set('plugin-a', pluginA)
      loadedPlugins.set('plugin-b', pluginB)

      const cycles = loader.detectDependencyCycles()
      expect(cycles).toEqual([])
    })

    it('should detect simple cycle', () => {
      // A -> B -> A
      const pluginA = createMockPlugin('plugin-a', { 'plugin-b': '^1.0.0' })
      const pluginB = createMockPlugin('plugin-b', { 'plugin-a': '^1.0.0' })

      const loadedPlugins = (loader as unknown as { loadedPlugins: Map<string, LoadedPlugin> }).loadedPlugins
      loadedPlugins.set('plugin-a', pluginA)
      loadedPlugins.set('plugin-b', pluginB)

      const cycles = loader.detectDependencyCycles()
      expect(cycles.length).toBeGreaterThan(0)
    })
  })

  describe('cascadeReload', () => {
    it('should fail for non-existent plugin', async () => {
      const result = await loader.cascadeReload('non-existent')

      expect(result.failedPlugins).toContainEqual({
        pluginId: 'non-existent',
        error: 'Plugin not found'
      })
      expect(result.reloadedPlugins).toEqual([])
    })

    it('should call onPluginReloaded callback', async () => {
      const pluginA = createMockPlugin('plugin-a')
      const loadedPlugins = (loader as unknown as { loadedPlugins: Map<string, LoadedPlugin> }).loadedPlugins
      loadedPlugins.set('plugin-a', pluginA)

      // Mock reloadPlugin to simulate failure
      vi.spyOn(loader, 'reloadPlugin').mockResolvedValue(null)

      const onPluginReloaded = vi.fn()
      await loader.cascadeReload('plugin-a', { onPluginReloaded })

      expect(onPluginReloaded).toHaveBeenCalled()
    })

    it('should stop on error when continueOnError is false', async () => {
      const pluginA = createMockPlugin('plugin-a')
      const pluginB = createMockPlugin('plugin-b', { 'plugin-a': '^1.0.0' })
      const pluginC = createMockPlugin('plugin-c', { 'plugin-b': '^1.0.0' })

      const loadedPlugins = (loader as unknown as { loadedPlugins: Map<string, LoadedPlugin> }).loadedPlugins
      loadedPlugins.set('plugin-a', pluginA)
      loadedPlugins.set('plugin-b', pluginB)
      loadedPlugins.set('plugin-c', pluginC)

      // Mock reloadPlugin to fail on plugin-a
      vi.spyOn(loader, 'reloadPlugin').mockResolvedValue(null)

      const result = await loader.cascadeReload('plugin-a', { continueOnError: false })

      // Should stop after first failure
      expect(result.failedPlugins.length).toBeGreaterThan(0)
    })

    it('should continue on error when continueOnError is true', async () => {
      const pluginA = createMockPlugin('plugin-a')
      const pluginB = createMockPlugin('plugin-b', { 'plugin-a': '^1.0.0' })

      const loadedPlugins = (loader as unknown as { loadedPlugins: Map<string, LoadedPlugin> }).loadedPlugins
      loadedPlugins.set('plugin-a', pluginA)
      loadedPlugins.set('plugin-b', pluginB)

      // Mock reloadPlugin to always fail
      vi.spyOn(loader, 'reloadPlugin').mockResolvedValue(null)

      const result = await loader.cascadeReload('plugin-a', { continueOnError: true })

      // Should attempt both plugins
      expect(result.failedPlugins.length).toBe(2)
    })

    it('should track duration', async () => {
      const pluginA = createMockPlugin('plugin-a')
      const loadedPlugins = (loader as unknown as { loadedPlugins: Map<string, LoadedPlugin> }).loadedPlugins
      loadedPlugins.set('plugin-a', pluginA)

      // Mock reloadPlugin
      vi.spyOn(loader, 'reloadPlugin').mockResolvedValue(null)

      const result = await loader.cascadeReload('plugin-a')

      expect(result.duration).toBeGreaterThanOrEqual(0)
    })
  })
})
