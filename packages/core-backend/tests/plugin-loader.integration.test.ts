/**
 * PluginLoader integration tests
 * Tests for plugin discovery and loading flow
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { PluginLoader } from '../src/core/plugin-loader'

describe('PluginLoader integration', () => {
  let loader: PluginLoader

  beforeEach(() => {
    vi.restoreAllMocks()
    loader = new PluginLoader('./test-plugins')
  })

  it('getPlugins returns a Map', () => {
    const plugins = loader.getPlugins()
    expect(plugins).toBeInstanceOf(Map)
  })

  it('getAll returns an array', () => {
    const all = loader.getAll()
    expect(Array.isArray(all)).toBe(true)
  })

  it('discover returns an array of plugin names', async () => {
    const discovered = await loader.discover()
    expect(Array.isArray(discovered)).toBe(true)
  })

  it('loadPlugins returns an array of loaded plugins', async () => {
    const loaded = await loader.loadPlugins()
    expect(Array.isArray(loaded)).toBe(true)
  })

  it('get returns undefined for non-existent plugin', () => {
    const plugin = loader.get('non-existent')
    expect(plugin).toBeUndefined()
  })
})
