/**
 * PluginLoader failure scenarios tests
 * Tests for error handling in plugin loading
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { PluginLoader } from '../src/core/plugin-loader'

describe('PluginLoader failure scenarios', () => {
  let loader: PluginLoader

  beforeEach(() => {
    vi.restoreAllMocks()
    loader = new PluginLoader('./test-plugins')
  })

  it('returns null when loading non-existent plugin', async () => {
    const result = await loader.load('non-existent-plugin')
    expect(result).toBeNull()
  })

  it('returns false when unloading non-existent plugin', () => {
    const result = loader.unload('non-existent-plugin')
    expect(result).toBe(false)
  })

  it('returns null when reloading non-existent plugin', async () => {
    const result = await loader.reloadPlugin('non-existent-plugin')
    expect(result).toBeNull()
  })

  it('handles discover on non-existent directory gracefully', async () => {
    const tempLoader = new PluginLoader('./non-existent-dir-12345')
    const discovered = await tempLoader.discover()
    expect(Array.isArray(discovered)).toBe(true)
    // Should return empty array, not throw
    expect(discovered.length).toBe(0)
  })

  it('returns empty array from loadPlugins when no plugins found', async () => {
    const tempLoader = new PluginLoader('./non-existent-dir-12345')
    const loaded = await tempLoader.loadPlugins()
    expect(Array.isArray(loaded)).toBe(true)
    expect(loaded.length).toBe(0)
  })
})
